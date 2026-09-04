import { normalizeMemory } from './normalize/run';
import type { Deps, Ingest } from './ports';

/**
 * Runs the lanes inline and does not return until done. Used by tests
 * (deterministic, no worker in between) and by an explicit `--wait`, for when
 * you are watching a terminal and would rather wait ten seconds than open
 * another window.
 *
 * Not the normal path: that one is the queue, because a person should never be
 * kept waiting on a model.
 */
export const inlineIngest = (deps: () => Deps): Ingest => ({
  async process(memoryId: string): Promise<void> {
    await normalizeMemory(deps(), memoryId);
  },
});
