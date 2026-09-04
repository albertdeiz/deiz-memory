import { coerce, grounded } from './values.js';
import type { FactField, FactType, FactValue } from './types.js';

/**
 * El prompt del extractor, armado **en runtime** desde `fact_types`.
 *
 * Mismo principio que el clasificador (§3.7): no hay una lista de campos
 * escrita en el código. Si la hubiera, agregar `poliza_salud` sería un deploy y
 * todo el diseño de §4 se caería.
 */

/** La cabecera, donde vive la mayoría de los datos duros. */
export const MAX_CONTEXT_CHARS = 5000;

/** Tope de líneas rescatadas por rótulo, para no rearmar el documento entero. */
const MAX_ANCHORED_LINES = 40;

/**
 * Qué parte del documento se le muestra al extractor.
 *
 * **No los primeros N caracteres.** Eso decidía la respuesta por accidente: en
 * una cartola real el `MONTO TOTAL FACTURADO A PAGAR` estaba en el carácter
 * 6157 y el corte era 6000, así que el modelo nunca vio la cifra correcta y
 * devolvió la del período anterior, que sí entraba. Ciento cincuenta y siete
 * caracteres separaban una respuesta buena de una mentira con formato.
 *
 * Así que va la cabecera **más cada línea que trae un rótulo declarado**. Es
 * barato —una pasada sobre las líneas—, cabe en el prompt, y garantiza que la
 * fila que responde esté delante aunque el documento tenga veinte páginas.
 */
export function relevantContext(type: FactType, text: string): string {
  const t = text.trim();
  if (t.length <= MAX_CONTEXT_CHARS) return t;

  const cabeza = t.slice(0, MAX_CONTEXT_CHARS);
  const anclas = type.fields
    .flatMap((f) => [...(f.near ?? []), ...(f.notNear ?? [])])
    .map((a) => a.toLowerCase());
  if (anclas.length === 0) return `${cabeza}\n[…recortado]`;

  const resto = t.slice(MAX_CONTEXT_CHARS);
  const rescatadas: string[] = [];
  for (const linea of resto.split('\n')) {
    const l = linea.toLowerCase();
    if (anclas.some((a) => l.includes(a))) rescatadas.push(linea);
    if (rescatadas.length >= MAX_ANCHORED_LINES) break;
  }

  return rescatadas.length === 0
    ? `${cabeza}\n[…recortado]`
    : `${cabeza}\n[…recortado, y estas líneas de más adelante:]\n${rescatadas.join('\n')}`;
}

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
    .map((f) => {
      // El rótulo que se va a verificar después va también en el prompt: pedirle
      // al modelo que apunte al lugar correcto es más barato que descartar lo
      // que trajo del lugar equivocado.
      const cerca = f.near?.length ? ` — búscalo junto a "${f.near[0]}"` : '';
      const lejos = f.notNear?.length ? `, NUNCA el de "${f.notNear[0]}"` : '';
      return `- ${f.name}: ${f.label} — ${COMO[f.kind]}${cerca}${lejos}`;
    })
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

  const partes = [
    ...(doc.note ? [`Nota de la persona: ${doc.note}`] : []),
    'Documento:',
    relevantContext(type, doc.text),
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
    if (!grounded(valor, f, source)) {
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
