'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/shared/api/client';
import { keys } from '@/shared/api/keys';
import type { SessionInfo } from '@/shared/api/types';

export function useSession() {
  return useQuery({
    queryKey: keys.session,
    queryFn: () => api.get<SessionInfo>('/api/session'),
    // The one query that must not be cached across a login: everything else
    // reads from it to decide whether to run at all.
    staleTime: 0,
    retry: false,
  });
}

/**
 * Entering, and the one thing that must not be done while doing it.
 *
 * The obvious move is `clear()`, and it is wrong here in a way that is easy to
 * miss: `clear()` REMOVES every query from the cache, and `refetchQueries` works
 * by finding queries IN the cache. Clear then refetch therefore refetches
 * nothing — `findAll` returns an empty list — and the gate above the form went on
 * showing the snapshot it already had. The login worked, the cookie was set, and
 * the screen stayed on the form until a manual reload.
 *
 * Invalidating is the right verb: it marks what exists as stale and refetches
 * whatever is being observed, the session included. And nothing needs clearing
 * on the way IN, because while logged out there was nothing to cache — every
 * data route answers 401.
 */
export function useEnter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => api.post<{ ownerId: string }>('/api/session', { code }),
    onSuccess: async () => {
      await qc.invalidateQueries();
    },
  });
}

/**
 * Leaving, where clearing IS right — the cache is full of someone's records —
 * so the session is written by hand rather than refetched.
 *
 * Same trap avoided from the other side: removing the session query and then
 * asking for it back would ask for nothing. Setting it says what is already
 * true, with no round trip, and the observer is notified by the write itself.
 */
export function useLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del('/api/session'),
    onSuccess: () => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
      qc.setQueryData(keys.session, { authenticated: false } satisfies SessionInfo);
    },
  });
}
