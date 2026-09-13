'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/shared/api/client';
import { keys } from '@/shared/api/keys';
import type { Overview, ReviewItem } from '@/shared/api/types';

export function useReview() {
  return useQuery({ queryKey: keys.review, queryFn: () => api.get<ReviewItem[]>('/api/review') });
}

export function useOverview() {
  return useQuery({ queryKey: keys.overview, queryFn: () => api.get<Overview>('/api/overview') });
}
