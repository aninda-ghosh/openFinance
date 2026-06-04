import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { documentsApi } from "./api";

export function useDocumentsList(filters?: { investmentId?: string; accountId?: string }) {
  return useQuery({
    queryKey: ["documents", filters],
    queryFn: () => documentsApi.getDocuments(filters),
  });
}

export function useUploadDocumentMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      parentId,
      name,
      file,
      notes,
    }: {
      parentId: { investmentId?: string | null; accountId?: string | null };
      name: string;
      file: File;
      notes?: string;
    }) => documentsApi.uploadDocument(parentId, name, file, notes),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["documents"] });
    },
  });
}

export function useDeleteDocumentMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docId }: { docId: string }) => documentsApi.deleteDocument(docId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["documents"] });
    },
  });
}
