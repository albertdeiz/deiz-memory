import { coerce, grounded } from './values.js';
import type { FactField, FactType, FactValue } from './types.js';

/**
 * El prompt del extractor, armado **en runtime** desde `fact_types`.
 *
 * Mismo principio que el clasificador (§3.7): no hay una lista de campos
 * escrita en el código. Si la hubiera, agregar `poliza_salud` sería un deploy y
 * todo el diseño de §4 se caería.
 */

/** Un extractor no necesita las 80 páginas: los datos duros viven al principio. */
export const MAX_CONTEXT_CHARS = 6000;

const COMO: Record<FactField['kind'], string> = {
  text: 'texto corto, tal como aparece',
  number: 'número (usa punto decimal)',
  uf: 'número de UF (solo la cifra, sin la palabra UF)',
  money: 'monto en pesos (solo la cifra, sin $ ni puntos)',
  date: 'fecha en formato YYYY-MM-DD',
  phone: 'teléfono, solo dígitos',
};

/**
 * El esquema de salida, también armado desde el registro.
 *
 * Nombrar los campos acá y no solo en el texto del prompt es lo que hace que un
 * modelo chico devuelva las claves correctas: se lo pide el servidor, no la
 * buena voluntad.
 */
export function extractSchema(type: FactType): object {
  const properties: Record<string, object> = {};
  for (const f of type.fields) properties[f.name] = { type: ['string', 'number', 'null'] };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['aplica', 'campos'],
    properties: {
      aplica: { type: 'boolean' },
      campos: { type: 'object', additionalProperties: false, properties },
    },
  };
}

export function buildExtractPrompt(
  type: FactType,
  doc: { text: string; note: string | null },
): { system: string; user: string } {
  const campos = type.fields
    .map((f) => `- ${f.name}: ${f.label} — ${COMO[f.kind]}`)
    .join('\n');

  const system = [
    `Extraes datos de documentos personales de una persona en Chile. Respondes solo JSON.`,
    '',
    `Tipo de documento esperado: ${type.label}.`,
    type.description,
    '',
    'Campos a extraer:',
    campos,
    '',
    'Reglas:',
    // La primera es la que evita que el extractor de pólizas invente una póliza
    // a partir de una boleta del supermercado.
    '- Si el documento NO es del tipo esperado, responde exactamente {"aplica": false}.',
    '- Si aplica, responde {"aplica": true, "campos": { ... }}.',
    '- Copia los valores EXACTOS del documento. No calcules, no conviertas, no redondees.',
    '- Un campo que el documento no dice va en null. Dejarlo en null es correcto;',
    '  inventarlo no. Cada valor se comprueba después contra el texto original.',
  ].join('\n');

  const t = doc.text.trim();
  const partes = [
    ...(doc.note ? [`Nota de la persona: ${doc.note}`] : []),
    'Documento:',
    t.length > MAX_CONTEXT_CHARS ? `${t.slice(0, MAX_CONTEXT_CHARS)}\n[…recortado]` : t,
  ];

  return { system, user: partes.join('\n\n') };
}

export interface Extraction {
  payload: Record<string, FactValue>;
  /** Los campos que el modelo dio y el documento no respalda. Van al log. */
  descartados: string[];
}

/**
 * Valida lo que devolvió el modelo contra el documento.
 *
 * Dos filtros, en orden: la **forma** del valor según su `kind`, y después que
 * el documento **lo diga de verdad**. El segundo es el que importa: es lo que
 * separa un dato extraído de una alucinación con formato correcto, y es la
 * misma idea que `grounding.ts` aplica a la prosa de una respuesta (§6).
 *
 * Devuelve `null` cuando el modelo dice que no aplica, o cuando no sobrevivió
 * ningún campo — un hecho vacío no es un hecho.
 */
export function validateExtraction(
  raw: unknown,
  type: FactType,
  source: string,
): Extraction | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.aplica === false) return null;

  const campos = (typeof o.campos === 'object' && o.campos !== null
    ? o.campos
    : o) as Record<string, unknown>;

  const payload: Record<string, FactValue> = {};
  const descartados: string[] = [];

  for (const f of type.fields) {
    const valor = coerce(campos[f.name], f.kind);
    if (valor === null) continue;
    if (!grounded(valor, f.kind, source)) {
      descartados.push(f.name);
      continue;
    }
    payload[f.name] = valor;
  }

  if (Object.keys(payload).length === 0) return null;

  // **Sin el campo identidad no es de este tipo.** Verificado en código y no
  // confiado a la descripción: sobre el corpus real, tres documentos distintos
  // del dominio `seguros` —una póliza, una liquidación de siniestro y un
  // certificado de cobertura— se tipificaron los tres como póliza, aunque la
  // descripción excluía los otros dos explícitamente. Un modelo chico lee esa
  // exclusión y la ignora; un `where` no.
  if (type.identityField && payload[type.identityField] === undefined) return null;

  return { payload, descartados };
}
