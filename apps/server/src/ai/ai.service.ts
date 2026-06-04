import { eq, inArray } from "drizzle-orm";
import { AI_CONFIG } from "../config/ai.config";
import { getDb } from "../db/index";
import { ai_conversations, ai_messages, ai_tool_calls } from "../db/schema";
import { appendExchange, deleteMemory } from "./chat-memory";
import { OllamaClient, type OllamaMessage } from "./ollama.client";
import { getFinancialAdvisorPrompt } from "./prompts/financial-advisor";
import { AI_TOOLS, executeTool } from "./tools/index";

export type AIResponse = {
  id: string;
  conversation_id: string;
  role: "assistant";
  content: string;
  confidence: "high" | "medium" | "low" | null;
  sources_json: string | null;
  created_at: string;
};

function _extractConfidence(text: string): "high" | "medium" | "low" | null {
  const upper = text.toUpperCase();
  if (upper.includes("CONFIDENCE: HIGH") || upper.includes("[HIGH]"))
    return "high";
  if (upper.includes("CONFIDENCE: MEDIUM") || upper.includes("[MEDIUM]"))
    return "medium";
  if (upper.includes("CONFIDENCE: LOW") || upper.includes("[LOW]"))
    return "low";
  return null;
}

function _extractSources(text: string): string | null {
  const matches = [...text.matchAll(/\[Tool: ([^\]]+)\]/g)];
  if (matches.length === 0) return null;
  return JSON.stringify(matches.map((m) => m[1]));
}

export class AIService {
  private client = new OllamaClient();

  // ─── Load conversation history ─────────────────────────────────────────────

  private async loadHistory(conversationId: string): Promise<OllamaMessage[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(ai_messages)
      .where(eq(ai_messages.conversation_id, conversationId))
      .orderBy(ai_messages.created_at);

    // Truncate to last N messages to prevent context window overflow
    const recent = rows.slice(-AI_CONFIG.maxHistoryMessages);
    return recent.map((r) => ({
      role: r.role as "user" | "assistant",
      content: r.content,
    }));
  }

  // ─── Ensure conversation exists ────────────────────────────────────────────

  private async ensureConversation(conversationId: string): Promise<void> {
    const db = getDb();
    const existing = await db
      .select({ id: ai_conversations.id })
      .from(ai_conversations)
      .where(eq(ai_conversations.id, conversationId));

    if (existing.length === 0) {
      await db.insert(ai_conversations).values({
        id: conversationId,
        title: "New Conversation",
      });
    }
  }

  // ─── Save user message ─────────────────────────────────────────────────────

  private async saveUserMessage(conversationId: string, content: string) {
    const db = getDb();
    const [row] = await db
      .insert(ai_messages)
      .values({ conversation_id: conversationId, role: "user", content })
      .returning();
    return row;
  }

  // ─── Public: streaming chat with tool-calling loop ────────────────────────

  async *stream(
    conversationId: string,
    userMessage: string,
    model?: string,
    displayCurrency = "INR",
    onToolCall?: (
      name: string,
      params: Record<string, any>,
      result: any
    ) => void
  ): AsyncGenerator<string> {
    await this.ensureConversation(conversationId);
    await this.saveUserMessage(conversationId, userMessage);

    const history = await this.loadHistory(conversationId);
    const systemMessage: OllamaMessage = {
      role: "system",
      content: getFinancialAdvisorPrompt(displayCurrency),
    };
    const messages: OllamaMessage[] = [
      systemMessage,
      ...history,
      { role: "user", content: userMessage },
    ];

    // Tool-calling loop: model fetches only the data it needs
    for (let i = 0; i < AI_CONFIG.maxToolIterations; i++) {
      const response = await this.client.chatWithTools(
        messages,
        { temperature: AI_CONFIG.temperature.analysis, tools: AI_TOOLS },
        model
      );

      if (!response.tool_calls || response.tool_calls.length === 0) break;

      messages.push({
        role: "assistant",
        content: response.content ?? "",
        tool_calls: response.tool_calls,
      });

      for (const tc of response.tool_calls) {
        let result: unknown;
        try {
          result = await executeTool(
            tc.function.name,
            tc.function.arguments as Record<string, unknown>,
            displayCurrency
          );
        } catch (e) {
          result = { error: String(e) };
        }

        if (onToolCall) {
          try {
            onToolCall(
              tc.function.name,
              tc.function.arguments as Record<string, unknown>,
              result
            );
          } catch (cbErr) {
            console.error("Error in onToolCall callback:", cbErr);
          }
        }

        messages.push({ role: "tool", content: JSON.stringify(result) });
      }
    }

    // Stream final answer with all fetched tool data in context
    const db = getDb();
    let fullContent = "";
    for await (const token of this.client.stream(
      messages,
      { temperature: AI_CONFIG.temperature.conversational },
      model
    )) {
      fullContent += token;
      yield token;
    }

    await db.insert(ai_messages).values({
      conversation_id: conversationId,
      role: "assistant",
      content: fullContent,
    });
    await appendExchange(conversationId, userMessage, fullContent).catch(
      () => {}
    );
  }

  // ─── Singleton helpers ─────────────────────────────────────────────────────

  async getSingletonMessages() {
    const db = getDb();
    await this.ensureConversation(AI_CONFIG.singletonConvId);
    return db
      .select()
      .from(ai_messages)
      .where(eq(ai_messages.conversation_id, AI_CONFIG.singletonConvId))
      .orderBy(ai_messages.created_at);
  }

  async clearSingleton() {
    const db = getDb();
    const msgs = await db
      .select({ id: ai_messages.id })
      .from(ai_messages)
      .where(eq(ai_messages.conversation_id, AI_CONFIG.singletonConvId));
    if (msgs.length > 0) {
      await db.delete(ai_tool_calls).where(
        inArray(
          ai_tool_calls.message_id,
          msgs.map((m) => m.id)
        )
      );
      await db
        .delete(ai_messages)
        .where(eq(ai_messages.conversation_id, AI_CONFIG.singletonConvId));
    }
    await deleteMemory(AI_CONFIG.singletonConvId).catch(() => {});
  }

  // ─── Status check ──────────────────────────────────────────────────────────

  async getStatus(): Promise<{
    connected: boolean;
    model: string;
    model_available: boolean;
    available_models: string[];
  }> {
    const [connected, available_models] = await Promise.all([
      this.client.ping(),
      this.client.listModels(),
    ]);
    const model_available =
      connected &&
      available_models.some(
        (m) => m === AI_CONFIG.model || m.startsWith(AI_CONFIG.model)
      );
    return {
      connected,
      model: AI_CONFIG.model,
      model_available,
      available_models,
    };
  }
}
