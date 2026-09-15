import { coerce, grounded, withoutLabel } from './values';
import type { FactField, FactType, FactValue } from './types';

/**
 * The extractor's prompt, assembled **at runtime** from the type registry.
 *
 * Same principle as the classifier: there is no field list written in the code.
 * If there were, adding a type would be a deploy, and the whole point of the
 * registry being data would collapse.
 */

/** The header, where most hard data lives. */
export const MAX_CONTEXT_CHARS = 5000;

/** Cap on label-rescued lines, so the whole document is not rebuilt. */
const MAX_ANCHORED_LINES = 40;

/**
 * Which part of the document the extractor is shown.
 *
 * **Not the first N characters.** That decided the answer by accident: in a real
 * statement the correct total sat at character 6157 and the cut was at 6000, so
 * the model never saw the right figure and returned the previous period's, which
 * did fit. A hundred and fifty-seven characters separated a good answer from a
 * well-formatted lie.
 *
 * So it gets the header **plus every line carrying a declared label**. Cheap —
 * one pass over the lines — it fits in the prompt, and it guarantees the row
 * that answers is in front of the model even in a twenty-page document.
 */
export function relevantContext(type: FactType, text: string): string {
  const t = text.trim();
  if (t.length <= MAX_CONTEXT_CHARS) return t;

  const header = t.slice(0, MAX_CONTEXT_CHARS);
  const anchors = type.fields
    .flatMap((f) => [...(f.near ?? []), ...(f.notNear ?? [])])
    .map((a) => a.toLowerCase());
  if (anchors.length === 0) return `${header}\n[…recortado]`;

  const rest = t.slice(MAX_CONTEXT_CHARS);
  const rescued: string[] = [];
  for (const line of rest.split('\n')) {
    if (anchors.some((a) => line.toLowerCase().includes(a))) rescued.push(line);
    if (rescued.length >= MAX_ANCHORED_LINES) break;
  }

  return rescued.length === 0
    ? `${header}\n[…recortado]`
    : `${header}\n[…recortado, y estas líneas de más adelante:]\n${rescued.join('\n')}`;
}

const SHAPE: Record<FactField['kind'], string> = {
  text: 'texto corto, tal como aparece',
  number: 'número (usa punto decimal)',
  uf: 'número de UF (solo la cifra, sin la palabra UF)',
  money: 'monto en pesos (solo la cifra, sin $ ni puntos)',
  date: 'fecha en formato YYYY-MM-DD',
  phone: 'teléfono, solo dígitos',
};

/**
 * The output schema, also assembled from the registry.
 *
 * Naming the fields here and not only in the prompt text is what makes a small
 * model return the right keys: the server asks for them, not good will.
 */
export function extractSchema(type: FactType): object {
  const properties: Record<string, object> = {};
  for (const f of type.fields) properties[f.name] = { type: ['string', 'number', 'null'] };
  const row = { type: 'object', additionalProperties: false, properties };

  // A `many` type asks for a list, and the server enforces it. Asking in prose
  // for "one entry per passenger" and hoping is how a document with two tickets
  // comes back with one.
  return {
    type: 'object',
    additionalProperties: false,
    required: ['aplica', 'campos'],
    properties: {
      aplica: { type: 'boolean' },
      campos: type.cardinality === 'many' ? { type: 'array', items: row } : row,
    },
  };
}

export function buildExtractPrompt(
  type: FactType,
  doc: { text: string; note: string | null },
): { system: string; user: string } {
  const fields = type.fields
    .map((f) => {
      // The label that gets verified later goes into the prompt too: asking the
      // model to aim at the right place is cheaper than discarding what it
      // brought from the wrong one.
      const near = f.near?.length ? ` — búscalo junto a "${f.near[0]}"` : '';
      const notNear = f.notNear?.length ? `, NUNCA el de "${f.notNear[0]}"` : '';
      return `- ${f.name}: ${f.label} — ${SHAPE[f.kind]}${near}${notNear}`;
    })
    .join('\n');

  const system = [
    `Extraes datos de documentos personales de una persona en Chile. Respondes solo JSON.`,
    '',
    `Tipo de documento esperado: ${type.label}.`,
    type.description,
    '',
    'Campos a extraer:',
    fields,
    '',
    'Reglas:',
    // The first rule is what stops the policy extractor from inventing a policy
    // out of a supermarket receipt.
    '- Si el documento NO es del tipo esperado, responde exactamente {"aplica": false}.',
    ...(type.cardinality === 'many'
      // The identity field is named, because it is what tells two rows apart and
      // a list of rows that share one is a list with one row in it.
      ? [
          '- Este documento puede traer VARIOS. Responde {"aplica": true, "campos": [ {...}, {...} ]},',
          `  uno por cada ${type.identityField ?? 'instancia'} distinto que aparezca. No repitas ninguno.`,
        ]
      : ['- Si aplica, responde {"aplica": true, "campos": { ... }}.']),
    '- Copia los valores EXACTOS del documento. No calcules, no conviertas, no redondees.',
    '- Un campo que el documento no dice va en null. Dejarlo en null es correcto;',
    '  inventarlo no. Cada valor se comprueba después contra el texto original.',
  ].join('\n');

  const partes = [
    ...(doc.note ? [`Nota de la persona: ${doc.note}`] : []),
    'Documento:',
    relevantContext(type, doc.text),
  ];

  return { system, user: partes.join('\n\n') };
}

export interface Extraction {
  payload: Record<string, FactValue>;
  /** Fields the model gave that the document does not back. For the log. */
  discarded: string[];
}

/**
 * Validates what the model returned against the document.
 *
 * Two filters, in order: the **shape** of the value per its kind, and then that
 * the document **actually says it**. The second is the one that matters: it is
 * what separates an extracted datum from a well-formatted hallucination.
 *
 * Returns `null` when the model says the type does not apply, or when no field
 * survived — an empty fact is not a fact.
 */
export function validateExtraction(
  raw: unknown,
  type: FactType,
  source: string,
): Extraction | null {
  const all = validateExtractions(raw, type, source);
  return all[0] ?? null;
}

/**
 * Every row the document backs, which for a `one` type is at most one.
 *
 * Rows are validated independently: a passenger whose seat is missing does not
 * take the other passenger with them.
 */
export function validateExtractions(
  raw: unknown,
  type: FactType,
  source: string,
): Extraction[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const o = raw as Record<string, unknown>;
  if (o.aplica === false) return [];

  const campos = o.campos;
  const rows: unknown[] = Array.isArray(campos)
    ? campos
    : [typeof campos === 'object' && campos !== null ? campos : o];

  const out: Extraction[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const one = validateRow(r, type, source);
    if (!one) continue;
    // Two rows with the same identity are one row said twice: the upsert would
    // collapse them anyway, and counting them would report work that did not
    // happen.
    const id = type.identityField ? String(one.payload[type.identityField] ?? '') : '';
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(one);
    if (type.cardinality !== 'many') break;
  }
  return out;
}

function validateRow(raw: unknown, type: FactType, source: string): Extraction | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const given = raw as Record<string, unknown>;

  const payload: Record<string, FactValue> = {};
  const discarded: string[] = [];

  for (const f of type.fields) {
    let value = coerce(given[f.name], f.kind);
    if (value === null) continue;
    // A text value often arrives with its own label glued to the front. Stripped
    // BEFORE grounding, so what gets verified against the document is the datum
    // that will be stored, not a longer string that happens to also be there.
    if (f.kind === 'text' && typeof value === 'string') value = withoutLabel(value, f);
    if (!grounded(value, f, source)) {
      discarded.push(f.name);
      continue;
    }
    payload[f.name] = value;
  }

  if (Object.keys(payload).length === 0) return null;

  // **No identity field, no type.** Verified in code rather than trusted to the
  // description: on the real corpus, three different documents in the insurance
  // category — a policy, a claim report and a coverage certificate — all typed as
  // a policy, though the description excluded the other two by name. A small
  // model reads that exclusion and ignores it. An `if` does not.
  if (type.identityField && payload[type.identityField] === undefined) return null;

  return { payload, discarded };
}
