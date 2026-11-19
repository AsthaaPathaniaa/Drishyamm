import { QueryClient } from '@tanstack/react-query';

// The app's one React Query cache. Lives in its own module so logout/login
// can clear it: its keys (['cameras'], ...) aren't per user, so without that
// the next account to sign in on this tab sees the last one's cameras until
// the cache goes stale.
//
// staleTime 60s / gcTime 10m: see main.jsx.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: 'always',
      staleTime: 60_000,
      gcTime:    10 * 60_000,
    },
  },
});
