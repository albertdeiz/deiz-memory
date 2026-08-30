import type { Db, Ingest } from './ports.js';

/**
 * F0: procesar es marcar. No hay OCR, transcripción ni conversión todavía —
 * eso llega en F1 y va a necesitar una cola, porque tarda segundos.
 * Este puerto existe para que ese cambio no toque capture().
 */
export const inlineIngest = (db: Db): Ingest => ({
  async process(memoryId: string): Promise<void> {
    await db.query(
      `update memories
          set status = case when normalized_text is not null then 'normalized' else 'raw' end,
              updated_at = now()
        where id = $1`,
      [memoryId],
    );
  },
});
