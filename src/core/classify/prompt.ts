import type { Domain } from '../ops/domains';

/**
 * The classifier's prompt, assembled **at runtime** from the domains table.
 *
 * There is no category list written in the code, anywhere. If there were, adding
 * a domain would require a deploy, and the whole point of categories being data
 * would collapse.
 *
 * And that is why each domain's description is not documentation: it is
 * literally what the model reads in order to decide. A vague description
 * clasifica mal.
 */
export interface ClassifyRequest {
  domains: Domain[];
  /** What was read out of the file. Clipped: the model does not need 80k characters. */
  text: string | null;
  /** What the person wrote. Worth more than the extracted text: it is intent. */
  note: string | null;
  filename: string | null;
  /** When it arrived, so "last Tuesday" can be resolved against something. */
  capturedAt: Date;
}

/** Un clasificador no necesita el documento entero: le basta el principio. */
export const MAX_CONTEXT_CHARS = 4000;

export interface Classification {
  /** Slug de un dominio existente, o null si ninguno calza. */
  domain: string | null;
  /** Short, concrete, no filler. It is what you see in a list. */
  title: string;
  /** Date of the event in ISO, or null when the document does not say. */
  occurredAt: string | null;
  /** How sure. Below the threshold it is stored anyway and flagged. */
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
 * Validates what the model returned against reality.
 *
 * A model can invent a domain that does not exist or an impossible date, and
 * trusting its output without checking would be exactly what never inventing
 * forbids. What fails the filter is discarded, not forced into shape.
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
    // An event date in the future, or earlier than any document this person could
    // hold, is a hallucinating model.
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
