/**
 * Every query key in one place.
 *
 * Scattered keys are how a mutation invalidates four of the five things it
 * changed. Curating a memory moves it between domains, can empty the review
 * inbox and changes what a search returns — so the fix is that the keys are
 * enumerable, not that everyone remembers.
 */
export const keys = {
  session: ['session'] as const,
  overview: ['overview'] as const,
  memories: (filters: object = {}) => ['memories', filters] as const,
  memory: (id: string) => ['memory', id] as const,
  domains: ['domains'] as const,
  facts: (all = false) => ['facts', { all }] as const,
  factTypes: ['factTypes'] as const,
  proposals: ['factProposals'] as const,
  review: ['review'] as const,
};
