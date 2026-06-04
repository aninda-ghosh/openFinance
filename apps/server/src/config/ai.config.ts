export const AI_CONFIG = {
  ollamaBaseUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  model: process.env.OLLAMA_MODEL ?? "gemma4:e2b",
  temperature: {
    analysis: 0.1,
    conversational: 0.4,
  },
  maxTokens: 4096,
  contextWindow: 16384,
  maxToolIterations: 5,
  // Single persistent conversation — no multi-thread
  singletonConvId: "__singleton__",
  // Max DB history messages sent to model to prevent context overflow
  maxHistoryMessages: 20,
};
