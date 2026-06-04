import { AIService } from "./ai.service";

export type GenerationEvent =
  | { type: "token"; data: string }
  | { type: "tool"; data: { name: string; params: any; result: string } }
  | { type: "done" }
  | { type: "error"; data: string };

export type HarnessListener = (event: GenerationEvent) => void;

export interface ActiveGenerationState {
  conversationId: string;
  accumulatedText: string;
  toolCalls: Array<{ name: string; params: any; result: string }>;
  isDone: boolean;
  error?: string;
}

interface ActiveGeneration {
  state: ActiveGenerationState;
  listeners: Set<HarnessListener>;
  promise: Promise<void>;
}

export class ChatHarness {
  private static instance: ChatHarness | null = null;
  private activeGenerations = new Map<string, ActiveGeneration>();
  private aiService = new AIService();

  static getInstance(): ChatHarness {
    if (!ChatHarness.instance) {
      ChatHarness.instance = new ChatHarness();
    }
    return ChatHarness.instance;
  }

  isGenerating(conversationId: string): boolean {
    return this.activeGenerations.has(conversationId);
  }

  getActiveState(conversationId: string): ActiveGenerationState | null {
    const gen = this.activeGenerations.get(conversationId);
    if (!gen) return null;
    return { ...gen.state };
  }

  addListener(conversationId: string, listener: HarnessListener): () => void {
    const gen = this.activeGenerations.get(conversationId);
    if (gen) {
      gen.listeners.add(listener);

      // Replay state accumulated so far to catch up this listener
      if (gen.state.accumulatedText) {
        listener({ type: "token", data: gen.state.accumulatedText });
      }
      for (const tc of gen.state.toolCalls) {
        listener({ type: "tool", data: tc });
      }
      if (gen.state.error) {
        listener({ type: "error", data: gen.state.error });
      } else if (gen.state.isDone) {
        listener({ type: "done" });
      }
    }
    return () => {
      const active = this.activeGenerations.get(conversationId);
      if (active) {
        active.listeners.delete(listener);
      }
    };
  }

  getOrCreateGeneration(
    conversationId: string,
    message: string,
    model?: string,
    currency = "INR"
  ): ActiveGeneration {
    let gen = this.activeGenerations.get(conversationId);
    if (gen) {
      return gen;
    }

    const listeners = new Set<HarnessListener>();
    const state: ActiveGenerationState = {
      conversationId,
      accumulatedText: "",
      toolCalls: [],
      isDone: false,
    };

    const broadcast = (event: GenerationEvent) => {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (e) {
          console.error("Error in harness listener:", e);
        }
      }
    };

    const promise = (async () => {
      try {
        const streamGenerator = this.aiService.stream(
          conversationId,
          message,
          model,
          currency,
          (name, params, result) => {
            const toolCall = {
              name,
              params,
              result:
                typeof result === "string" ? result : JSON.stringify(result),
            };
            state.toolCalls.push(toolCall);
            broadcast({ type: "tool", data: toolCall });
          }
        );

        for await (const token of streamGenerator) {
          state.accumulatedText += token;
          broadcast({ type: "token", data: token });
        }

        state.isDone = true;
        broadcast({ type: "done" });
      } catch (err: any) {
        console.error("[Harness Background Error]:", err);
        const errorMsg =
          err?.name === "OllamaConnectionError"
            ? "AI service unavailable — Ollama is not running"
            : (err?.message ?? "Stream error");
        state.error = errorMsg;
        state.isDone = true;
        broadcast({ type: "error", data: errorMsg });
      } finally {
        // Keep active generation in memory for 15 seconds after completion
        // so late clients or re-attaching clients can catch the final state safely.
        setTimeout(() => {
          this.activeGenerations.delete(conversationId);
        }, 15000);
      }
    })();

    gen = {
      state,
      listeners,
      promise,
    };

    this.activeGenerations.set(conversationId, gen);
    return gen;
  }
}
