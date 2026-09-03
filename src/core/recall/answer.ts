import type { Actor } from '../domain/types.js';
import type { Deps } from '../ports.js';
import { err, ok, type Result } from '../result.js';
import { retrieve, type Passage, type RetrieveInput } from './retrieve.js';

/**
 * Responder una pregunta con lo que guardaste.
 *
 * Las dos reglas duras que mandan acá:
 *
 *   1. Nunca responder un dato factual sin `memory_id` de respaldo.
 *   2. Si no está guardado, la respuesta correcta es "no lo tengo" — no una
 *      inferencia plausible.
 *
 * Por eso el modelo no responde de su conocimiento: responde **solo** sobre los
 * pasajes recuperados, y cada afirmación tiene que apuntar a uno. Una respuesta
 * sin cita se descarta antes de mostrarse.
 */
export interface AnswerInput extends RetrieveInput {
  /** Sin esto se devuelven los pasajes crudos, que ya es útil y no cuesta. */
  synthesize?: boolean;
}

export interface Answer {
  /** La respuesta en prosa, o null si no se pudo responder con lo guardado. */
  text: string | null;
  /** Los pasajes en que se apoya. Siempre presentes, aunque no haya prosa. */
  sources: Passage[];
  /** Por qué no hay respuesta, cuando no la hay. */
  reason: 'sin_resultados' | 'sin_modelo' | 'sin_cita' | null;
}

/** Cuántos pasajes se le dan al modelo. Más que esto diluye y cuesta. */
const MAX_PASSAGES = 6;

export async function answer(
  deps: Deps,
  actor: Actor,
  input: AnswerInput,
): Promise<Result<Answer>> {
  const found = await retrieve(deps, actor, input);
  if (!found.ok) return found;
  const sources = found.value;

  if (sources.length === 0) {
    // "No lo tengo" es una respuesta correcta y frecuente. §15 la mide.
    return ok({ text: null, sources: [], reason: 'sin_resultados' });
  }
  if (!input.synthesize || !deps.classifier) {
    return ok({ text: null, sources, reason: input.synthesize ? 'sin_modelo' : null });
  }

  const usados = sources.slice(0, MAX_PASSAGES);
  const contexto = usados
    .map((p, i) => `[${i + 1}] ${p.title ?? 'sin título'} (${fecha(p)})\n${p.content}`)
    .join('\n\n---\n\n');

  // Corto y en orden de importancia, no exhaustivo.
  //
  // La primera versión listaba siete reglas —incluida la de no dar consejo
  // médico y la de fragmentos contradictorios— y un modelo de 3B respondía
  // NO_LO_TENGO a una pregunta que los fragmentos contestaban. Con el mismo
  // contexto y estas cuatro líneas, contesta "el deducible es de 5 UF por
  // siniestro [1]". A un modelo chico, una lista larga de restricciones le
  // suena a "mejor no arriesgarse".
  //
  // Lo que se sacó no se perdió: no inventar y no exceder lo guardado se
  // verifica en código más abajo, que es donde de verdad se puede garantizar.
  const system = [
    'Respondes con los fragmentos que te doy.',
    'Da el dato concreto en una o dos frases, no un resumen.',
    'Copia números, montos y fechas exactos.',
    'Solo si ninguno de los fragmentos toca el tema, responde NO_LO_TENGO.',
    '',
    // Con el ejemplo puesto y no solo descrito. Sin él, un modelo chico cita en
    // prosa —"se encuentra en el primer fragmento"— que es una cita para un
    // humano y no para el código que tiene que resolverla a un id.
    'Termina cada frase con el número del fragmento entre corchetes. Así:',
    'El deducible es de 5 UF por siniestro [1].',
  ].join('\n');

  const texto = (await deps.classifier.complete({
    system,
    user: `Fragmentos:\n\n${contexto}\n\n---\n\nPregunta: ${input.query}`,
  })).trim() || null;
  if (!texto || /NO_LO_TENGO/i.test(texto)) {
    // El modelo dice que no está. Se le cree: es justo lo que pide la regla 2.
    return ok({ text: null, sources, reason: 'sin_resultados' });
  }

  // Regla dura 1, verificada y no confiada: una respuesta factual sin cita no
  // se muestra. Que el prompt lo pida no garantiza que el modelo obedezca.
  //
  // Antes de descartarla se pide una vez más, porque el fallo típico no es
  // inventar: es citar en prosa —"según el primer fragmento"— que sirve para
  // una persona y no para el código que tiene que resolverla a un id.
  let final = texto;
  if (!/\[\d+\]/.test(final)) {
    const reintento = (await deps.classifier.complete({
      system: 'Reescribe la respuesta poniendo el número del fragmento entre corchetes al final de cada frase. No cambies ningún dato.',
      user: `Fragmentos:\n\n${contexto}\n\n---\n\nRespuesta a corregir: ${final}`,
    })).trim();
    if (/\[\d+\]/.test(reintento)) final = reintento;
    else return ok({ text: null, sources, reason: 'sin_cita' });
  }

  return ok({ text: resolveCitations(final, usados), sources: usados, reason: null });
}

const fecha = (p: Passage): string =>
  (p.occurredAt ?? p.capturedAt).toISOString().slice(0, 10);

/**
 * Cambia [1] por el id corto de la memoria.
 *
 * Un número entre corchetes no sirve de nada media hora después; un id sí, y
 * `dm show` lo abre. La cita tiene que llevar al documento (§3.2).
 */
function resolveCitations(text: string, sources: Passage[]): string {
  return text.replace(/\[(\d+)\]/g, (m, n) => {
    const p = sources[Number(n) - 1];
    return p ? `[${p.shortId}]` : m;
  });
}
