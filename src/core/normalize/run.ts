import type { Uuid } from '../domain/types.js';
import { shortId } from '../domain/types.js';
import { looksLikeText } from '../media.js';
import type { Converter, Deps, ExtractInput } from '../ports.js';
import { err, isPermanent, ok, type Result } from '../result.js';
import { canonical, clamp, isPoor, lanesFor, type Lane } from './lanes.js';

/** Qué se intentó y cómo salió. Es lo que hace legible un reproceso a los 6 meses. */
export interface Attempt {
  lane: Lane;
  ok: boolean;
  detail: string;
}

export interface NormalizeOutcome {
  id: Uuid;
  shortId: string;
  lane: Lane;
  chars: number;
  error: string | null;
  attempts: Attempt[];
}

/**
 * Leer un archivo de texto no necesita herramienta: es el carril más barato y el
 * único que nunca puede faltar. Vive acá y no en capture() para que reprocesar un
 * .txt pase por exactamente el mismo camino que reprocesar un PDF (UC-15).
 */
const textConverter: Converter = {
  async extract({ bytes }: ExtractInput) {
    if (!looksLikeText(bytes)) throw new Error('los bytes no son texto legible');
    const decoded = bytes.toString('utf8');
    if (decoded.includes('�')) throw new Error('el archivo no viene en UTF-8');
    return { text: decoded, detail: { encoding: 'utf-8' } };
  },
  async available() {
    return { ok: true, detail: 'no necesita nada' };
  },
};

const converterFor = (deps: Deps, lane: Lane): Converter | null => {
  if (lane === 'text') return textConverter;
  if (lane === 'document') return deps.converters.document;
  if (lane === 'vision') return deps.converters.vision;
  if (lane === 'audio') return deps.converters.audio;
  return null;
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Row {
  id: string;
  blob_sha256: string | null;
  original_filename: string | null;
  media_type: string | null;
  storage_key: string | null;
}

/**
 * Corre los carriles sobre una memoria y guarda lo que salga.
 *
 * No recibe un actor a propósito: la llama el worker, que procesa lo que le
 * toca por id. Todo camino que venga de una persona (dm reprocess) resuelve
 * primero contra su dueño y recién después llega acá.
 *
 * Nunca lanza por un carril que falla. Un fallo se guarda en la fila —
 * `normalization_error`— y queda esperando a `dm reprocess --failed`. Reventar
 * dejaría la memoria en un limbo donde el worker la reintenta para siempre.
 */
export async function normalizeMemory(deps: Deps, memoryId: Uuid): Promise<Result<NormalizeOutcome>> {
  const { rows } = await deps.db.query<Row>(
    `select m.id, m.blob_sha256, m.original_filename, b.media_type, b.storage_key
       from memories m left join blobs b on b.sha256 = m.blob_sha256
      where m.id = $1`,
    [memoryId],
  );
  if (rows.length === 0) return err('not_found', `No existe la memoria ${memoryId}.`);

  const row = rows[0]!;
  const id = row.id;
  const short = shortId(id);

  // Solo nota: no hay blob del cual derivar nada, y eso no es un fallo.
  if (!row.blob_sha256 || !row.storage_key) {
    await save(deps, id, { text: null, lane: 'none', error: null, detail: { reason: 'memoria sin archivo' } });
    return ok({ id, shortId: short, lane: 'none', chars: 0, error: null, attempts: [] });
  }

  const candidates = lanesFor(row.media_type);
  if (candidates.length === 0) {
    const detail = { reason: 'sin carril', mediaType: row.media_type };
    await save(deps, id, { text: null, lane: 'none', error: null, detail });
    return ok({ id, shortId: short, lane: 'none', chars: 0, error: null, attempts: [] });
  }

  let bytes: Buffer;
  try {
    bytes = await deps.blobs.get(row.storage_key);
  } catch (e) {
    // El blob es lo único irrecuperable: si no está, no hay nada que reprocesar
    // y hay que gritarlo, no anotarlo como un carril fallido más.
    await save(deps, id, { text: null, lane: 'none', error: `no se pudo leer el original: ${message(e)}`, detail: {} });
    return err('not_found', `El original de ${short} no está en el storage: ${message(e)}`);
  }

  const input: ExtractInput = {
    bytes,
    mediaType: row.media_type!,
    filename: row.original_filename,
  };

  const attempts: Attempt[] = [];
  let best: { text: string; lane: Lane; detail: Record<string, unknown>; incomplete?: string } | null = null;
  let unfinished: string | null = null;
  // Arranca en `true` y solo baja: si CUALQUIER carril falló por algo
  // transitorio, reintentar puede servir. Se necesita que todos los caminos
  // estén cerrados para decir que no.
  let retryable = false;
  let anyFailure = false;

  for (const lane of candidates) {
    const converter = converterFor(deps, lane);
    if (!converter) {
      attempts.push({ lane, ok: false, detail: 'carril no configurado' });
      unfinished ??= `el carril "${lane}" no está configurado`;
      anyFailure = true;
      // Configurar un carril es cambiar el entorno, no volver a intentar. Pero
      // una vez configurado el reproceso sí sirve, así que cuenta como algo que
      // se arregla sin tocar código.
      retryable = true;
      continue;
    }
    try {
      const out = await converter.extract(input);
      const text = out.text ?? '';
      attempts.push({ lane, ok: true, detail: `${text.trim().length} caracteres` });
      if (!best || text.trim().length > best.text.trim().length) {
        best = { text, lane, detail: out.detail ?? {}, ...(out.incomplete ? { incomplete: out.incomplete } : {}) };
        // Este carril dio algo mejor que todo lo anterior, así que lo que falló
        // antes ya no explica el resultado. Sin este olvido, una boleta leída
        // perfectamente por OCR quedaba marcada con "el carril document no está
        // configurado" solo porque markitdown no corrió — y markitdown no tenía
        // nada que aportar sobre un escaneo de todos modos.
        if (text.trim().length > 0) unfinished = null;
      }
      // Suficiente texto: no hay razón para pagar el carril siguiente.
      if (!isPoor(text)) {
        unfinished = null;
        break;
      }
    } catch (e) {
      attempts.push({ lane, ok: false, detail: message(e) });
      unfinished ??= `el carril "${lane}" falló: ${message(e)}`;
      anyFailure = true;
      if (!isPermanent(e)) retryable = true;
    }
  }

  // Un resultado pobre con un carril pendiente no es un éxito: se guarda lo que
  // hay, pero queda marcado para que dm reprocess --failed lo retome cuando el
  // carril que faltaba exista.
  const poor = isPoor(best?.text);
  const error = best === null
    ? (unfinished ?? 'ningún carril produjo texto')
    // Un texto incompleto no es un éxito aunque sea largo: se guarda, se dice, y
    // queda seleccionable por `dm reprocess --failed`.
    : (best.incomplete ?? (poor && unfinished ? unfinished : null));

  const clamped = best ? clamp(canonical(best.text)) : { text: '', truncated: false };
  const finalText = clamped.text.trim() || null;

  await save(deps, id, {
    text: finalText,
    lane: best?.lane ?? 'none',
    error,
    // Un texto incompleto o de poca confianza no falló: el carril hizo lo que
    // podía. Reintentarlo daría exactamente lo mismo, así que tampoco es
    // reintentable — lo que necesita es otro carril, u ojos.
    retryable: error === null ? null : anyFailure ? retryable : false,
    detail: { ...(best?.detail ?? {}), attempts, ...(clamped.truncated ? { truncated: true } : {}) },
  });

  // Indexar va acá y no en un paso aparte: los trozos derivan del texto, así
  // que cada vez que el texto cambia hay que rehacerlos o la búsqueda semántica
  // queda respondiendo con lo viejo. Que falle no invalida la normalización.
  if (deps.embedder && finalText) {
    const owner = await deps.db.query<{ owner_id: string }>(
      `select owner_id from memories where id = $1`, [id],
    );
    const ownerId = owner.rows[0]?.owner_id;
    if (ownerId) {
      const { indexMemory } = await import('../recall/index-chunks.js');
      await indexMemory(deps, { ownerId }, id).catch(() => {});
    }
  }

  return ok({
    id,
    shortId: short,
    lane: best?.lane ?? 'none',
    chars: finalText?.length ?? 0,
    error,
    attempts,
  });
}

interface Saved {
  text: string | null;
  lane: Lane;
  error: string | null;
  /** `null` cuando no hubo error; si no, si `dm reprocess` puede ayudar. */
  retryable?: boolean | null;
  detail: Record<string, unknown>;
}

/**
 * `normalized_at` se escribe pase lo que pase: significa "esto ya se corrió",
 * no "esto salió bien". Sin eso, una memoria que falla se queda en la cola de
 * pendientes y el worker la reintenta hasta el fin de los tiempos.
 *
 * Y una corrida que falla **no toca lo que ya había**, ni el texto ni su
 * procedencia. El caso que obliga a esto: una foto transcrita hace meses por el
 * carril de visión, la API key vence, y el reproceso saca 30 caracteres de
 * basura por el carril de documentos. Sin esta guarda, esos 30 caracteres
 * reemplazan la transcripción buena — y "todo lo derivado es regenerable" pasa
 * de ser una red a ser un riesgo. Nadie reprocesa su histórico si puede quedar
 * peor que antes.
 *
 * El carril, el detalle y la fecha viajan con el texto: quedarse con la
 * transcripción vieja pero marcarla como `lane = none` sería mentir sobre de
 * dónde salió, y `dm reprocess --lane vision` ya no podría encontrarla.
 */
async function save(deps: Deps, id: Uuid, s: Saved): Promise<void> {
  // La condición se evalúa contra los valores ANTERIORES de la fila, que es
  // justo lo que hace falta, y en una sola sentencia para que dos workers no
  // puedan pisarse.
  const keep = `$4::text is not null and normalized_text is not null`;
  await deps.db.query(
    `update memories
        set normalized_text      = case when ${keep} then normalized_text      else $2       end,
            normalization_lane   = case when ${keep} then normalization_lane   else $3       end,
            normalization_detail = case when ${keep} then normalization_detail else $5::jsonb end,
            normalized_at        = case when ${keep} then normalized_at        else $6       end,
            normalization_error  = $4,
            normalization_retryable = $7,
            -- El estado dice la verdad: lo que necesita una mirada humana
            -- queda en needs_review. Antes una corrida con error dejaba el
            -- estado anterior, y una memoria sin una sola letra extraida podia
            -- figurar como normalizada.
            status               = case when $4::text is null then 'normalized' else 'needs_review' end,
            updated_at           = now()
      where id = $1`,
    [id, s.text, s.lane, s.error, JSON.stringify(s.detail), deps.clock.now(), s.retryable ?? null],
  );
}
