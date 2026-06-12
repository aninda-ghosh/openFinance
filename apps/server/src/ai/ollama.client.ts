import { AI_CONFIG } from "../config/ai.config";
import { getOllamaModel, getOllamaUrl } from "../services/settings.service";

export type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
};

export type OllamaToolCall = {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
};

export type ChatOptions = {
  temperature?: number;
  tools?: unknown[];
};

export class OllamaConnectionError extends Error {
  constructor() {
    super(`Cannot connect to Ollama at ${getOllamaUrl()}`);
    this.name = "OllamaConnectionError";
  }
}

export class OllamaClient {
  // Resolved per request so Settings changes apply without a restart
  private get baseUrl() {
    return getOllamaUrl();
  }
  private get model() {
    return getOllamaModel();
  }

  async chat(
    messages: OllamaMessage[],
    options?: ChatOptions
  ): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          options: {
            temperature:
              options?.temperature ?? AI_CONFIG.temperature.conversational,
            num_ctx: AI_CONFIG.contextWindow,
          },
          tools: options?.tools,
        }),
      });
    } catch {
      throw new OllamaConnectionError();
    }

    if (!response.ok) {
      this.throwIfModelMissing(response.status, await response.text());
    }

    const data = (await response.json()) as {
      message: OllamaMessage;
      done: boolean;
    };
    return data.message.content ?? "";
  }

  async chatWithTools(
    messages: OllamaMessage[],
    options?: ChatOptions,
    modelOverride?: string
  ): Promise<OllamaMessage> {
    let response: Response;
    const model = modelOverride ?? this.model;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          options: {
            temperature: options?.temperature ?? AI_CONFIG.temperature.analysis,
            num_ctx: AI_CONFIG.contextWindow,
          },
          tools: options?.tools,
        }),
      });
    } catch {
      throw new OllamaConnectionError();
    }

    if (!response.ok) {
      this.throwIfModelMissing(response.status, await response.text());
    }

    const data = (await response.json()) as { message: OllamaMessage };
    return data.message;
  }

  async *stream(
    messages: OllamaMessage[],
    options?: ChatOptions,
    modelOverride?: string
  ): AsyncGenerator<string> {
    let response: Response;
    const model = modelOverride ?? this.model;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          options: {
            temperature:
              options?.temperature ?? AI_CONFIG.temperature.conversational,
            num_ctx: AI_CONFIG.contextWindow,
          },
        }),
      });
    } catch {
      throw new OllamaConnectionError();
    }

    if (!response.ok || !response.body) {
      this.throwIfModelMissing(response.status, "");
      throw new Error("Failed to connect to Ollama: no response body received");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as {
            message?: { content?: string };
            done?: boolean;
          };
          if (parsed.message?.content) yield parsed.message.content;
          if (parsed.done) return;
        } catch {
          // skip malformed lines
        }
      }
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: { name: string }[] };
      return (data.models ?? []).map((m) => m.name);
    } catch {
      return [];
    }
  }

  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private throwIfModelMissing(status: number, body: string, model?: string) {
    if (status === 404) {
      const m = model ?? this.model;
      throw Object.assign(
        new Error(`Model "${m}" is not installed. Run: ollama pull ${m}`),
        { name: "OllamaModelNotFoundError" }
      );
    }
    throw new Error(`Ollama error: ${status} ${body}`);
  }
}
