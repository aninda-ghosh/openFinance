import type { z } from "zod";
import type {
  ChatMessageSchema,
  CreateConversationSchema,
} from "../schemas/ai.schema";

export type CreateConversationRequest = z.infer<
  typeof CreateConversationSchema
>;
export type ChatMessageRequest = z.infer<typeof ChatMessageSchema>;

export type MessageResponse = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  confidence: "high" | "medium" | "low" | null;
  sources_json: string | null;
  created_at: string;
};

export type ConversationResponse = {
  id: string;
  title: string;
  messages: MessageResponse[];
  created_at: string;
  updated_at: string;
};

export type ConversationListResponse = {
  conversations: {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
  }[];
};

export type ChatResponse = {
  message: MessageResponse;
};
