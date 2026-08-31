import type { Capabilities, Option, Reply } from '../../core/channel/types.js';
import type { MemorySummary } from '../../core/domain/types.js';
import { meaningfulName } from '../../core/filenames.js';
import { encodeAction } from '../../core/router/actions.js';
import type { Outcome } from '../../core/router/route.js';
import type { Result } from '../../core/result.js';

/**
 * El único lugar donde vive la prosa del chat — el gemelo de
 * `src/adapters/cli/format.ts`.
 *
 * Vive en `adapters/chat/` y no dentro de `telegram/` porque WhatsApp lo va a
 * compartir entero: lo único que cambia entre canales es el transporte y los
 * números de las capacidades.
 */

const KINDS: [string, string][] = [
  ['application/pdf', 'PDF'], ['image/', 'foto'], ['audio/', 'audio'],
  ['video/', 'video'], ['text/', 'texto'],
];

const kindOf = (mediaType: string | null): string =>
  KINDS.find(([p]) => mediaType?.startsWith(p))?.[1] ?? 'archivo';

/** Igual que en el CLI: un nombre de cámara no es un título. */
const label = (m: MemorySummary): string =>
  m.title ?? meaningfulName(m.originalFilename) ?? m.excerpt ?? `(${kindOf(m.mediaType)} sin nombre)`;

const day = (d: Date | null): string =>
  d ? new Date(d).toISOString().slice(0, 10) : '—';

/**
 * Botones si el canal los tiene, lista numerada si no — **con las mismas
 * acciones en los dos casos**.
 *
 * Esta función es toda la degradación de §7.1. No hay dos ramas de lógica:
 * hay una lista de opciones y dos formas de mostrarla, porque la acción del
 * botón y la palabra que se escribe son la misma cadena (`router/actions.ts`).
 */
const withOptions = (body: string, options: Option[], caps: Capabilities): Reply => {
  if (options.length === 0) return { kind: 'text', body };
  if (caps.supportsButtons) return { kind: 'text', body, options };
  return {
    kind: 'text',
    body: `${body}\n\n${options.map((o) => `· ${o.action}  — ${o.label}`).join('\n')}`,
    options,
  };
};

export function present(result: Result<Outcome>, caps: Capabilities): Reply[] {
  if (!result.ok) return [failure(result, caps)];
  const v = result.value;

  switch (v.kind) {
    case 'ayuda':
      return [{
        kind: 'text',
        body: [
          'Mándame lo que quieras —una foto, un PDF, una nota de voz, o texto— y lo guardo.',
          '',
          'Para encontrarlo después, pregúntame o usa /buscar.',
          '',
          '/buscar <algo>   busca en todo lo que guardaste',
          '/pendientes      qué me falta por leer',
          '/ayuda           esto',
        ].join('\n'),
      }];

    case 'pareado':
      return [{
        kind: 'text',
        body: v.displayName
          ? `Listo, ${v.displayName}. Mándame lo que quieras y lo guardo.`
          : 'Listo. Mándame lo que quieras y lo guardo.',
      }];

    case 'guardado': {
      const c = v.capture;
      const dedup = c.deduped ? '\nYa lo tenías: es el mismo archivo, pero queda como memoria aparte.' : '';
      // El acuse dice el ESTADO, no solo "éxito". Sin esta línea la espera es
      // invisible; con ella es una espera declarada, que es otra cosa.
      const leyendo = v.enCola
        ? '\nLo estoy leyendo — en un rato lo vas a poder buscar por lo que dice adentro.'
        : '';
      return [{ kind: 'text', body: `Guardado ✓  ${c.shortId}${dedup}${leyendo}` }];
    }

    case 'pendientes':
      return [{
        kind: 'text',
        body: v.sinLeer === 0
          ? 'No me falta nada por leer.'
          : `Me faltan ${v.sinLeer} por leer. Pregúntame en un rato.`,
      }];

    case 'detalle': {
      const m = v.memory;
      const lines = [label(m), `${day(m.occurredAt ?? m.capturedAt)} · ${m.shortId}`];
      if (m.note) lines.push('', `tu nota: ${m.note}`);
      if (m.normalizationError) lines.push('', `⚠ ${m.normalizationError}`);
      if (m.normalizedText) {
        const t = m.normalizedText.trim();
        lines.push('', t.length > 1200 ? `${t.slice(0, 1200)}…` : t);
      } else if (m.sha256 && !m.normalizedAt) {
        lines.push('', 'Todavía no lo he leído.');
      }
      const options: Option[] = m.sha256
        ? [{ label: 'mandarme el original', action: encodeAction({ kind: 'abrir', n: 1 }) }]
        : [];
      return [withOptions(lines.join('\n'), options, caps)];
    }

    case 'archivo':
      return [{
        kind: 'file',
        filename: v.blob.filename,
        mediaType: v.blob.mediaType,
        bytes: v.blob.bytes,
      }];

    case 'resultados':
      return resultados(v, caps);
  }
}

function resultados(
  v: Extract<Outcome, { kind: 'resultados' }>,
  caps: Capabilities,
): Reply[] {
  // La línea de pendientes no es cortesía: una búsqueda que dice "no lo tengo"
  // mientras un OCR corre está mintiendo, y §15 mide justamente eso.
  const leyendo = v.pendientes > 0
    ? `\n\n(${v.pendientes === 1 ? 'Falta 1 cosa' : `Faltan ${v.pendientes} cosas`} por leer — si no aparece, pregúntame en un rato.)`
    : '';

  if (v.items.length === 0) {
    // Pedir "más" y que no quede nada no es lo mismo que no tenerlo: lo primero
    // es el final de una lista, lo segundo una respuesta sobre tu memoria.
    if (v.agotado) return [{ kind: 'text', body: 'No hay más.' }];
    const options: Option[] = v.ofreceGuardar
      ? [{ label: 'guardarlo como nota', action: encodeAction({ kind: 'guardar' }) }]
      : [];
    return [withOptions(`No lo tengo.${leyendo}`, options, caps)];
  }

  const numbered = v.items
    .map((m, i) => `${i + 1}. ${label(m)}\n   ${day(m.occurredAt ?? m.capturedAt)} · ${m.shortId}`)
    .join('\n');

  const desde = v.offset + 1;
  const hasta = v.offset + v.items.length;
  const head = `${desde}–${hasta} de lo que encontré para "${v.consulta}":`;

  const options: Option[] = v.items.map((_, i) => ({
    label: `ver ${i + 1}`,
    action: encodeAction({ kind: 'ver', n: i + 1 }),
  }));
  if (v.hayMas) options.push({ label: 'más', action: encodeAction({ kind: 'mas' }) });

  return [withOptions(`${head}\n\n${numbered}${leyendo}`, options, caps)];
}

/** Errores y confirmaciones. Qué pasó y qué hacer, sin disculpas. */
function failure(
  result: Extract<Result<unknown>, { ok: false }>,
  caps: Capabilities,
): Reply {
  if (result.kind === 'requires_confirmation') {
    const afectados = result.affects.map((a) => `· ${a.label ?? a.id}`).join('\n');
    return withOptions(
      `${result.message}\n${afectados}`,
      [
        { label: 'sí, hazlo', action: encodeAction({ kind: 'si' }) },
        { label: 'no', action: encodeAction({ kind: 'no' }) },
      ],
      caps,
    );
  }
  const detail = result.detail as { matches?: string[] } | undefined;
  if (result.kind === 'ambiguous' && detail?.matches) {
    return { kind: 'text', body: `${result.message}\n${detail.matches.map((m) => `· ${m}`).join('\n')}` };
  }
  return { kind: 'text', body: result.message };
}
