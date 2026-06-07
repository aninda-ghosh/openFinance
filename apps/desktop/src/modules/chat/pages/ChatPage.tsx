import {
  Bot,
  ChevronDown,
  Loader2,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  User,
  WifiOff,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAppStore } from "@/stores/app.store";
import { chatApi } from "../api";
import { useChatMessages, useClearChat } from "../hooks/useChat";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

const mdComponents = {
  p: ({ children }: any) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }: any) => (
    <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>
  ),
  ol: ({ children }: any) => (
    <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>
  ),
  li: ({ children }: any) => <li>{children}</li>,
  strong: ({ children }: any) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }: any) => <em className="italic">{children}</em>,
  code: ({ children }: any) => (
    <code className="font-mono text-xs bg-black/10 dark:bg-white/10 rounded px-1 py-0.5">
      {children}
    </code>
  ),
  pre: ({ children }: any) => (
    <pre className="font-mono text-xs bg-black/10 dark:bg-white/10 rounded p-2 my-1 overflow-x-auto whitespace-pre-wrap">
      {children}
    </pre>
  ),
  h1: ({ children }: any) => <p className="font-bold mb-1">{children}</p>,
  h2: ({ children }: any) => <p className="font-semibold mb-1">{children}</p>,
  h3: ({ children }: any) => <p className="font-medium mb-1">{children}</p>,
};

function MarkdownContent({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={`text-sm leading-relaxed ${className ?? ""}`}>
      <ReactMarkdown components={mdComponents}>{content}</ReactMarkdown>
    </div>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${isUser ? "bg-indigo-500" : "bg-muted border"}`}
      >
        {isUser ? (
          <User className="w-4 h-4 text-white" />
        ) : (
          <Bot className="w-4 h-4 text-muted-foreground" />
        )}
      </div>
      <div
        className={`max-w-[78%] rounded-2xl px-4 py-2.5 ${
          isUser
            ? "bg-indigo-500 text-white rounded-tr-sm"
            : "bg-muted rounded-tl-sm text-foreground"
        }`}
      >
        {isUser ? (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            {msg.content}
          </p>
        ) : (
          <MarkdownContent content={msg.content} />
        )}
      </div>
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-3">
      <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 bg-muted border">
        <Bot className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="max-w-[78%] rounded-2xl rounded-tl-sm px-4 py-2.5 bg-muted text-foreground">
        {text ? (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{text}</p>
        ) : (
          <span className="inline-flex gap-1 text-sm">
            <span className="animate-bounce" style={{ animationDelay: "0ms" }}>
              ●
            </span>
            <span
              className="animate-bounce"
              style={{ animationDelay: "150ms" }}
            >
              ●
            </span>
            <span
              className="animate-bounce"
              style={{ animationDelay: "300ms" }}
            >
              ●
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

export default function ChatPage() {
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [inFlightUserMessage, setInFlightUserMessage] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<{
    toolCalls: Array<{ name: string; params: any; result: string }>;
  } | null>(null);
  const [aiStatus, setAiStatus] = useState<
    "checking" | "available" | "no_model" | "unavailable"
  >("checking");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [startingOllama, setStartingOllama] = useState(false);
  const aiModel = useAppStore((s) => s.aiModel);
  const setAiModel = useAppStore((s) => s.setAiModel);
  const defaultCurrency = useAppStore((s) => s.defaultCurrency);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data, refetch } = useChatMessages();
  const { mutate: clearChat, isPending: clearing } = useClearChat();

  const messages: Message[] = (data?.messages ?? []).filter(
    (m: any) => m.role === "user" || m.role === "assistant"
  );

  const checkStatus = () => {
    chatApi
      .getStatus()
      .then((d) => {
        const models = d.available_models ?? [];
        setAvailableModels(models);
        if (!d.connected) {
          setAiStatus("unavailable");
          return;
        }
        // Check if the *user-selected* model is available
        const modelOk = models.some(
          (m) => m === aiModel || m.startsWith(aiModel)
        );
        setAiStatus(modelOk ? "available" : "no_model");
      })
      .catch(() => setAiStatus("unavailable"));
  };

  useEffect(() => {
    checkStatus();
    const id = setInterval(checkStatus, 20_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkStatus]);

  // Scroll to bottom only when user is already near the bottom (don't interrupt reading)
  useEffect(() => {
    if (isAtBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, []);

  // Always scroll when a new completed message lands (user just sent something)
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    isAtBottomRef.current = true;
  }, []);

  // Auto-grow textarea height dynamically based on input content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
    }
  }, [input]);

  const reconnectToOngoingStream = () => {
    setStreaming(true);
    setStreamText("");

    const controller = chatApi.streamChat(
      null,
      {
        onToken: (token) => {
          setStreamText((prev) => prev + token);
        },
        onTool: (tool) => {
          setActiveTask((prev) => {
            const tc = {
              name: tool.name,
              params: tool.params,
              result: tool.result,
            };
            if (!prev) return { toolCalls: [tc] };
            if (
              prev.toolCalls.some(
                (t) =>
                  t.name === tool.name &&
                  JSON.stringify(t.params) === JSON.stringify(tool.params)
              )
            ) {
              return prev;
            }
            return { toolCalls: [...prev.toolCalls, tc] };
          });
        },
        onDone: () => {
          setStreaming(false);
          setStreamText("");
          setActiveTask(null);
          refetch();
        },
        onError: (error) => {
          toast.error(error);
          setStreaming(false);
          setStreamText("");
          setActiveTask(null);
          refetch();
          checkStatus();
        },
      },
      aiModel,
      defaultCurrency
    );
    abortRef.current = controller;
  };

  // On mount, check if there is an active background generation
  useEffect(() => {
    chatApi
      .getGeneratingStatus()
      .then((res) => {
        if (res.generating && res.state) {
          const parsedTools = (res.state.toolCalls || []).map((t) => ({
            name: t.name,
            params: t.params,
            result: t.result,
          }));
          setActiveTask({ toolCalls: parsedTools });
          reconnectToOngoingStream();
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiModel]);

  const sendMessage = () => {
    const text = input.trim();
    if (!text || streaming || aiStatus !== "available") return;
    setInput("");
    setStreaming(true);
    setStreamText("");
    setInFlightUserMessage(text);
    setActiveTask(null);

    const controller = chatApi.streamChat(
      text,
      {
        onToken: (token) => setStreamText((prev) => prev + token),
        onTool: (tool) => {
          setActiveTask((prev) => {
            const tc = {
              name: tool.name,
              params: tool.params,
              result: tool.result,
            };
            if (!prev) return { toolCalls: [tc] };
            if (
              prev.toolCalls.some(
                (t) =>
                  t.name === tool.name &&
                  JSON.stringify(t.params) === JSON.stringify(tool.params)
              )
            ) {
              return prev;
            }
            return { toolCalls: [...prev.toolCalls, tc] };
          });
        },
        onDone: async () => {
          await refetch();
          setStreaming(false);
          setStreamText("");
          setActiveTask(null);
          setInFlightUserMessage(null);
        },
        onError: async (error) => {
          toast.error(error);
          await refetch();
          setStreaming(false);
          setStreamText("");
          setActiveTask(null);
          setInFlightUserMessage(null);
          checkStatus();
        },
      },
      aiModel,
      defaultCurrency
    );
    abortRef.current = controller;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const startOllama = async () => {
    setStartingOllama(true);
    try {
      const res = await chatApi.startOllama();
      if (res.started) {
        setAiStatus("available");
        toast.success(res.message ?? "Ollama is running");
      } else {
        toast.error(res.message ?? "Could not start Ollama");
        checkStatus();
      }
    } catch {
      toast.error("Could not start Ollama — make sure it is installed");
      checkStatus();
    } finally {
      setStartingOllama(false);
    }
  };

  const isUnavailable = aiStatus === "unavailable" || aiStatus === "no_model";

  return (
    <div className="flex flex-col h-full pb-14 md:pb-0">
      {/* Header */}
      <div className="border-b px-5 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-indigo-500/10 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-indigo-500" />
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight">openFinance AI</p>
            {availableModels.length > 1 ? (
              <div className="relative">
                <select
                  value={aiModel}
                  onChange={(e) => {
                    setAiModel(e.target.value);
                    setTimeout(checkStatus, 0);
                  }}
                  className="text-xs text-muted-foreground bg-transparent border-none outline-none cursor-pointer appearance-none pr-4 leading-tight"
                >
                  {availableModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <ChevronDown className="w-2.5 h-2.5 text-muted-foreground absolute right-0 top-0.5 pointer-events-none" />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground leading-tight">
                {aiModel} · local
              </p>
            )}
          </div>
          {aiStatus === "checking" && (
            <span className="text-xs text-muted-foreground ml-1 flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              Connecting…
            </span>
          )}
          {aiStatus === "available" && (
            <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400 ml-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
              Online
            </span>
          )}
          {aiStatus === "no_model" && (
            <span className="inline-flex items-center gap-1 text-xs text-red-500 ml-1">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />
              Model missing
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-xs text-muted-foreground"
          disabled={clearing || messages.length === 0}
          onClick={() =>
            clearChat(undefined, {
              onSuccess: () => {
                setInFlightUserMessage(null);
                toast.success("Chat cleared");
              },
            })
          }
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Clear
        </Button>
      </div>

      {/* Unavailable banner */}
      {aiStatus === "unavailable" && (
        <div className="mx-4 mt-4 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 flex items-center justify-between gap-4 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <WifiOff className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                AI bot not available
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                Ollama is not running. Install from{" "}
                <span className="font-mono">ollama.com</span>, then run:{" "}
                <span className="font-mono font-medium">
                  ollama pull gemma4:e2b
                </span>
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="border-amber-400 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900 flex-shrink-0 gap-1.5"
            disabled={startingOllama}
            onClick={startOllama}
          >
            {startingOllama ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                Start Ollama
              </>
            )}
          </Button>
        </div>
      )}
      {aiStatus === "no_model" && (
        <div className="mx-4 mt-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 px-4 py-3 flex-shrink-0">
          <div className="flex items-start gap-2.5">
            <WifiOff className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-red-800 dark:text-red-200">
                Model not installed
              </p>
              <p className="text-xs text-red-700 dark:text-red-400 mt-0.5">
                Ollama is running but{" "}
                <span className="font-mono font-medium">gemma4:e2b</span> is not
                installed. Run this in your terminal:
              </p>
              <code className="block mt-1.5 text-xs bg-red-100 dark:bg-red-900/50 rounded px-2 py-1 font-mono text-red-800 dark:text-red-200">
                ollama pull gemma4:e2b
              </code>
              {availableModels.length > 0 && (
                <p className="text-xs text-red-600 dark:text-red-400 mt-1.5">
                  Installed models:{" "}
                  <span className="font-mono">
                    {availableModels.join(", ")}
                  </span>
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto no-scrollbar px-4 py-4"
        onScroll={() => {
          const el = scrollContainerRef.current;
          if (!el) return;
          isAtBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {messages.length === 0 && !streaming ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 pt-20 text-center">
            <Sparkles className="w-10 h-10 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground max-w-xs">
              Ask me anything about your finances — net worth, budget,
              investments, policies, or savings goals.
            </p>
            <div className="flex flex-wrap gap-2 justify-center mt-2">
              {[
                "What's my net worth?",
                "How's my budget this month?",
                "Which investment is performing best?",
                "When is my next premium due?",
              ].map((q) => (
                <button
                  key={q}
                  disabled={isUnavailable}
                  onClick={() => {
                    setInput(q);
                    textareaRef.current?.focus();
                  }}
                  className="text-xs px-3 py-1.5 rounded-full border hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-5 max-w-3xl mx-auto">
            {messages.map((m) => (
              <MessageBubble key={m.id} msg={m} />
            ))}

            {inFlightUserMessage && (
              <MessageBubble
                msg={{
                  id: "inflight-user",
                  role: "user",
                  content: inFlightUserMessage,
                }}
              />
            )}

            {activeTask && activeTask.toolCalls.length > 0 && (
              <div className="bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900 rounded-2xl p-4 space-y-3 max-w-3xl mx-auto shadow-sm backdrop-blur-sm">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 text-indigo-500 animate-spin" />
                  <span className="text-xs font-semibold text-indigo-900 dark:text-indigo-200">
                    AI Financial Engine Processing
                  </span>
                  <span className="text-[10px] bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 px-2 py-0.5 rounded-full font-medium ml-auto">
                    Background active
                  </span>
                </div>

                <p className="text-xs text-indigo-700/80 dark:text-indigo-300/80 leading-normal">
                  openFinance AI is analyzing your data locally and performing necessary calculations. You can safely navigate away or close the app; the completed analysis will be saved here automatically.
                </p>

                <div className="border-t border-indigo-100/50 dark:border-indigo-900/50 pt-2.5 space-y-2">
                  <p className="text-[10px] font-bold text-indigo-500 uppercase tracking-wider">
                    Executed Tools & APIs
                  </p>
                  <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                    {activeTask.toolCalls.map((tc, index) => {
                      const label = tc.name
                        .replace(/_/g, " ")
                        .replace(/\b\w/g, (c) => c.toUpperCase());
                      return (
                        <div
                          key={index}
                          className="flex items-start gap-2 bg-white/50 dark:bg-black/10 rounded px-2.5 py-1.5 border border-indigo-50/50 dark:border-indigo-900/20 text-xs"
                        >
                          <span className="text-green-500 font-bold shrink-0">
                            ✓
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-slate-700 dark:text-slate-200 leading-normal">
                              {label}
                            </p>
                            {tc.name === "calculate" &&
                              tc.params?.expression && (
                                <code className="text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-1 py-0.5 rounded block mt-0.5 break-all font-mono">
                                  Expr: {tc.params.expression}
                                </code>
                              )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {streaming && <StreamingBubble text={streamText} />}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t px-4 py-3 flex-shrink-0">
        <div className="max-w-3xl mx-auto flex gap-2 items-end">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isUnavailable
                ? "AI bot not available…"
                : "Ask about your finances… (Enter to send, Shift+Enter for newline)"
            }
            disabled={streaming || isUnavailable}
            rows={1}
            className="flex-1 resize-none min-h-[40px] max-h-36"
          />
          <Button
            onClick={sendMessage}
            disabled={!input.trim() || streaming || isUnavailable}
            size="icon"
            className="h-10 w-10 flex-shrink-0"
          >
            {streaming ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground text-center mt-2">
          Runs fully on your device — your data never leaves your machine.
        </p>
      </div>
    </div>
  );
}
