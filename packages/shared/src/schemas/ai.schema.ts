import { z } from "zod";

export const ConfidenceEnum = z.enum(["high", "medium", "low"]);

export const CreateConversationSchema = z.object({
  title: z.string().min(1),
});

export const ChatMessageSchema = z.object({
  conversation_id: z.string().min(1),
  content: z.string().min(1),
});
