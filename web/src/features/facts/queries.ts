'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/shared/api/client';
import { keys } from '@/shared/api/keys';
import type { Fact, FactType, TypeProposal } from '@/shared/api/types';

export function useFacts(all = false) {
  return useQuery({ queryKey: keys.facts(all), queryFn: () => api.get<Fact[]>(`/api/facts?all=${all}`) });
}

export function useFactTypes() {
  return useQuery({ queryKey: keys.factTypes, queryFn: () => api.get<FactType[]>('/api/facts/types') });
}

/**
 * Proposals cost a model call per orphan document, so they are never automatic.
 * `enabled` keeps the query from running until someone asks for it.
 */
export function useProposals(enabled: boolean) {
  return useQuery({
    queryKey: keys.proposals,
    queryFn: () => api.get<TypeProposal[]>('/api/facts/proposals'),
    enabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}

export function useAcceptProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { proposal: TypeProposal; confirm: boolean }) =>
      api.post('/api/facts/proposals', v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.factTypes });
      void qc.invalidateQueries({ queryKey: keys.proposals });
    },
  });
}

/** Re-reading one memory with the types that apply to it now. */
export function useExtract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memoryId: string) => api.post('/api/facts/extract', { memoryId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.facts() });
      void qc.invalidateQueries({ queryKey: keys.facts(true) });
      void qc.invalidateQueries({ queryKey: keys.overview });
    },
  });
}
