'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/shared/api/client';
import { keys } from '@/shared/api/keys';
import type { Domain } from '@/shared/api/types';

export function useDomains() {
  return useQuery({ queryKey: keys.domains, queryFn: () => api.get<Domain[]>('/api/domains') });
}

const refresh = (qc: ReturnType<typeof useQueryClient>) => () => {
  void qc.invalidateQueries({ queryKey: keys.domains });
  void qc.invalidateQueries({ queryKey: keys.overview });
  void qc.invalidateQueries({ queryKey: ['memories'] });
};

export function useCreateDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { label: string; description: string }) => api.post<Domain>('/api/domains', input),
    onSuccess: refresh(qc),
  });
}

export function useEditDomain(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { label?: string; description?: string }) =>
      api.patch<Domain>(`/api/domains/${slug}`, patch),
    onSuccess: refresh(qc),
  });
}

export function useArchiveDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.post<Domain>(`/api/domains/${slug}/archive`),
    onSuccess: refresh(qc),
  });
}

/** Merging is confirmed like a purge: it moves every memory and archives one. */
export function useMergeDomains() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { from: string; into: string; confirm: boolean }) =>
      api.post('/api/domains/merge', v),
    onSuccess: refresh(qc),
  });
}
