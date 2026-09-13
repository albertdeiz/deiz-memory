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

export function useEnter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => api.post<{ ownerId: string }>('/api/session', { code }),
    onSuccess: async () => {
      // Everything cached belonged to nobody a moment ago, so clearing beats
      // invalidating: there is no shared data between "logged out" and "logged in".
      qc.clear();
      // But clearing is not enough, and the missing half is what made a
      // successful login look like a failed one: `clear()` REMOVES the session
      // query instead of refetching it, so the mounted observer was left with no
      // data and `isLoading` false — which reads as "not authenticated", and the
      // login form stayed up until the page was reloaded by hand.
      await qc.refetchQueries({ queryKey: keys.session });
    },
  });
}

export function useLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del('/api/session'),
    // Same on the way out: without the refetch the shell keeps rendering over a
    // session that no longer exists, and every panel fills with 401s.
    onSuccess: async () => {
      qc.clear();
      await qc.refetchQueries({ queryKey: keys.session });
    },
  });
}
