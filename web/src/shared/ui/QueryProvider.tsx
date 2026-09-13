'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/shared/api/client';

/**
 * Built inside the component and not at module scope: a client shared across
 * requests would hand one visitor's cache to the next. One owner today makes
 * that harmless and it is not a habit worth having in a file about sessions.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Retrying a 404 or a 401 wastes time and hides the answer. Only
        // transport failures are worth a second attempt.
        retry: (count, error) =>
          error instanceof ApiError && error.kind === 'offline' && count < 2,
      },
      mutations: { retry: false },
    },
  }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
