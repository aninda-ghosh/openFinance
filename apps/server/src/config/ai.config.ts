// The Ollama endpoint and model are runtime settings — see
// services/settings.service.ts (in-app Settings page → env vars → localhost).
export const AI_CONFIG = {
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
