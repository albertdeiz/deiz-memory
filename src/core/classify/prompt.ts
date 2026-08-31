import type { Domain } from '../ops/domains.js';

/**
 * El prompt del clasificador, armado **en runtime** desde la tabla `domains`.
 *
 * No hay una lista de categorías escrita en el código, en ningún lado (§3.7 y
 * §7). Si la hubiera, agregar un dominio requeriría un deploy, y todo el diseño
 * de §9 se caería.
 *
 * Y por eso la `description` de cada dominio no es documentación: es
 * literalmente lo que el modelo lee para decidir. Una descripción vaga
 * clasifica mal.
 */
export interface ClassifyRequest {
  domains: Domain[];
  /** Lo que se extrajo del archivo. Se recorta: el modelo no necesita 80 mil caracteres. */
  text: string | null;
  /** Lo que escribió la persona. Vale más que el texto extraído: es intención. */
  note: string | null;
  filename: string | null;
  /** Cuándo entró, para poder resolver "el martes pasado" contra algo. */
  capturedAt: Date;
}

/** Un clasificador no necesita el documento entero: le basta el principio. */
export const MAX_CONTEXT_CHARS = 4000;

export interface Classification {
  /** Slug de un dominio existente, o null si ninguno calza. */
  domain: string | null;
  /** Corto, concreto, sin relleno. Es lo que vas a ver en una lista. */
  title: string;
  /** Fecha del hecho en ISO, o null si el documento no la dice. */
  occurredAt: string | null;
  /** Qué tan seguro. Por debajo del umbral se guarda igual y se marca (§3.4). */
  confidence: number;
  tags: string[];
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['domain', 'title', 'occurredAt', 'confidence', 'tags'],
  properties: {
    domain: { type: ['string', 'null'] },
    title: { type: 'string' },
    occurredAt: { type: ['string', 'null'] },
    confidence: { type: 'number' },
    tags: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const classifySchema = SCHEMA;

export function buildPrompt(req: ClassifyRequest): { system: string; user: string } {
  const catalogo = req.domains
    .map((d) => `- ${d.slug}: ${d.description}`)
    .join('\n');

  const system = [
    'Clasificas documentos personales de una persona en Chile. Respondes solo JSON.',
    '',
    'Categorías disponibles (usa el identificador de la izquierda, exacto):',
    catalogo,
    '',
    'Reglas:',
    '- `domain`: el identificador que mejor calce, o null si ninguno calza de verdad.',
    '  Forzar una categoría equivocada es peor que dejarlo sin clasificar.',
    '- `title`: máximo 8 palabras, concreto y en español. Nombra QUÉ es el documento',
    '  y de quién o de qué trata. Nada de "Documento escaneado" ni "Imagen".',
    '- `occurredAt`: la fecha del HECHO en formato YYYY-MM-DD — cuándo se emitió el',
    '  documento o cuándo pasó lo que describe. Si el texto no la dice, null.',
    '  No la inventes ni uses la fecha de captura.',
    '- `confidence`: 0 a 1. Si dudas entre dos categorías, baja de 0.7.',
    '- `tags`: hasta 5 palabras sueltas útiles para buscarlo después. Sin repetir el título.',
    '',
    'Nunca inventes datos que no estén en el texto.',
  ].join('\n');

  const partes: string[] = [];
  if (req.note) partes.push(`Nota que escribió la persona: ${req.note}`);
  if (req.filename) partes.push(`Nombre del archivo: ${req.filename}`);
  partes.push(`Fecha de captura: ${req.capturedAt.toISOString().slice(0, 10)}`);
  if (req.text) {
    const t = req.text.trim();
    partes.push(
      'Contenido:',
      t.length > MAX_CONTEXT_CHARS ? `${t.slice(0, MAX_CONTEXT_CHARS)}\n[…recortado]` : t,
    );
  }

  return { system, user: partes.join('\n\n') };
}

/**
 * Valida lo que devolvió el modelo contra la realidad.
 *
 * Un modelo puede inventarse un dominio que no existe o una fecha imposible, y
 * confiar en su salida sin comprobarla sería justo lo que la regla dura 2
 * prohíbe. Lo que no pasa el filtro se descarta, no se corrige a la fuerza.
 */
export function validate(raw: unknown, domains: Domain[]): Classification | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const title = typeof o.title === 'string' ? o.title.trim().slice(0, 120) : '';
  if (!title) return null;

  const slugs = new Set(domains.map((d) => d.slug));
  const domain = typeof o.domain === 'string' && slugs.has(o.domain) ? o.domain : null;

  let occurredAt: string | null = null;
  if (typeof o.occurredAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.occurredAt)) {
    const d = new Date(`${o.occurredAt}T12:00:00Z`);
    // Una fecha del hecho en el futuro, o anterior a que existieran los
    // documentos que esta persona podría tener, es un modelo alucinando.
    const year = d.getUTCFullYear();
    if (!Number.isNaN(d.getTime()) && year >= 1900 && d.getTime() <= Date.now() + 86_400_000) {
      occurredAt = o.occurredAt;
    }
  }

  const confidence =
    typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1
      ? o.confidence
      : 0.5;

  const tags = Array.isArray(o.tags)
    ? o.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 1)
        .map((t) => t.trim().toLowerCase().slice(0, 40))
        .slice(0, 5)
    : [];

  return { domain, title, occurredAt, confidence, tags };
}
