'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/shared/api/client';
import { keys } from '@/shared/api/keys';
import type { Fact, MemoryDetail, MemorySummary } from '@/shared/api/types';

export interface Filters {
  q?: string;
  domain?: string | null;
  limit?: number;
  offset?: number;
}

const toQuery = (f: Filters): string => {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.domain) p.set('domain', f.domain);
  if (f.limit) p.set('limit', String(f.limit));
  if (f.offset) p.set('offset', String(f.offset));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export function useMemories(filters: Filters) {
  return useQuery({
    queryKey: keys.memories(filters),
    queryFn: () => api.get<MemorySummary[]>(`/api/memories${toQuery(filters)}`),
    // Typing in the search box should not blank the list on every keystroke.
    placeholderData: (prev) => prev,
  });
}

export function useMemory(id: string | null) {
  return useQuery({
    queryKey: keys.memory(id ?? ''),
    queryFn: () => api.get<{ memory: MemoryDetail; facts: Fact[] }>(`/api/memories/${id}`),
    enabled: Boolean(id),
  });
}

export interface CuratePatch {
  domain?: string | null;
  title?: string | null;
  occurredAt?: string | null;
  tags?: string[];
}

/**
 * Correcting a memory touches more than the memory.
 *
 * It can move it between categories, empty a slot in the review inbox and change
 * what a search returns. Invalidating only the row it edited is how a screen
 * ends up showing a category that no longer contains what it lists.
 */
export function useCurate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: CuratePatch) => api.patch(`/api/memories/${id}`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.memory(id) });
      void qc.invalidateQueries({ queryKey: ['memories'] });
      void qc.invalidateQueries({ queryKey: keys.review });
      void qc.invalidateQueries({ queryKey: keys.overview });
      void qc.invalidateQueries({ queryKey: keys.domains });
    },
  });
}

export function useHide(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hidden: boolean) => api.post(`/api/memories/${id}/hide`, { hidden }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.memory(id) });
      void qc.invalidateQueries({ queryKey: ['memories'] });
    },
  });
}

/**
 * Purging is two calls on purpose, and the first one is expected to fail.
 *
 * Without `confirm` the server answers 409 with what it would destroy, named.
 * The UI shows that and calls again. Sending `confirm: true` on the first try
 * would work and would be wrong: the confirmation exists so a person reads the
 * name of what disappears (§13.8).
 */
export function usePurge(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (confirm: boolean) =>
      api.del(`/api/memories/${id}${confirm ? '?confirm=true' : ''}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['memories'] });
      void qc.invalidateQueries({ queryKey: keys.overview });
      void qc.invalidateQueries({ queryKey: keys.facts() });
    },
  });
}
