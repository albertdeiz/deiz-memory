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
    // Everything cached belonged to nobody a moment ago. Clearing beats
    // invalidating: there is no shared data between "logged out" and "logged in".
    onSuccess: () => qc.clear(),
  });
}

export function useLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del('/api/session'),
    onSuccess: () => qc.clear(),
  });
}
