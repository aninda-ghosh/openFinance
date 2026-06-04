import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { chatApi } from "../api";

export function useChatMessages() {
  return useQuery({
    queryKey: ["chat-messages"],
    queryFn: chatApi.getMessages,
    staleTime: Infinity,
  });
}

export function useClearChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: chatApi.clearChat,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["chat-messages"] }),
  });
}
