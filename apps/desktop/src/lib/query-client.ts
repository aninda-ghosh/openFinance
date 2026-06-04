import { QueryClient, MutationCache } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0, // data is always stale
      refetchOnMount: true, // refetch whenever a page mounts (i.e. on navigation)
      refetchOnWindowFocus: true, // auto-refetch when user focuses/switches back to window
      refetchInterval: 2 * 60 * 1000, // auto-refetch active queries every 2 minutes if left open
      retry: 1,
    },
  },
  mutationCache: new MutationCache({
    onSuccess: () => {
      // Globally invalidate every query key to trigger background refetches
      queryClient.invalidateQueries();
    },
  }),
});
