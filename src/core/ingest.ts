import { normalizeMemory } from './normalize/run';
import type { Deps, Ingest } from './ports';

/**
 * Corre los carriles ahí mismo y no vuelve hasta terminar. Es lo que usan los
 * tests (deterministas, sin worker de por medio) y `dm capture --wait`, para
 * cuando estás en la terminal mirando y prefieres esperar diez segundos antes
 * que abrir otra ventana.
 *
 * No es el camino normal: ese es la cola (§7, "nunca hacer esperar al usuario
 * por un LLM").
 */
export const inlineIngest = (deps: () => Deps): Ingest => ({
  async process(memoryId: string): Promise<void> {
    await normalizeMemory(deps(), memoryId);
  },
});
