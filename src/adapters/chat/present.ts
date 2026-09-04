import type { Capabilities, Option, Reply } from '../../core/channel/types';
import { excerptOf, type MemorySummary } from '../../core/domain/types';
import { conflicting, contextOf, renderValue, warningFor } from '../../core/facts/format';
import type { FactHit } from '../../core/facts/query';
import { meaningfulName } from '../../core/filenames';
import { encodeAction } from '../../core/router/actions';
import type { Outcome } from '../../core/router/route';
import type { Result } from '../../core/result';

/**
 * The only place the chat's prose lives — the twin of the CLI formatter.
 * `src/adapters/cli/format.ts`.
 *
 * It sits beside the transports rather than inside one because the next
 * channel shares it whole: all that changes between channels is the transport
 * and the capability numbers.
 */

const KINDS: [string, string][] = [
  ['application/pdf', 'PDF'], ['image/', 'foto'], ['audio/', 'audio'],
  ['video/', 'video'], ['text/', 'texto'],
];

/** A readable size: on a phone "126 KB" says more than 129024. */
const size = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

const kindOf = (mediaType: string | null): string =>
  KINDS.find(([p]) => mediaType?.startsWith(p))?.[1] ?? 'file';

/** As in the CLI: a camera filename is not a title. */
const label = (m: MemorySummary): string =>
  m.title ?? meaningfulName(m.originalFilename) ?? m.excerpt ?? `(${kindOf(m.mediaType)} sin nombre)`;

const day = (d: Date | null): string =>
  d ? new Date(d).toISOString().slice(0, 10) : '—';

/**
 * Buttons where the channel has them, a numbered list where it does not —
 * acciones en los dos casos**.
 *
 * This function IS the whole degradation. There are not two branches of logic:
 * there is one list of options and two ways to show it, because the button's
 * action and the typed word are the same string.
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


/**
 * A list's actions: for each item, the data and the file.
 *
 * **This is the pattern for EVERY listing the bot hands over** — search
 * results, a category, the review inbox and an answer's sources. Each one
 * building its own buttons is exactly what made asking offer only `view` while
 * searching offered `view` and `open`: it is not a different decision per
 * screen, it is the same one, and it belongs in one place.
 *
 * Both go together because they are the two things you want to do with a
 * result, and splitting them — opening the detail just to reach the original —
 * made downloading a document cost two taps and an intermediate screen.
 *
 * `group` places them side by side where the channel has rows. Where it does
 * not, they are listed like any other action: degradation does not depend on it.
 */
const porItem = (items: readonly { mediaType: string | null }[]): Option[] =>
  items.flatMap((m, i) => {
    const n = i + 1;
    const fila: Option[] = [{ label: `${n} · datos`, action: encodeAction({ kind: 'view', n }), group: n }];
    // With no original file, downloading is not offered: a button that knows it
    // fallar es peor que no estar.
    if (m.mediaType) {
      fila.push({ label: `${n} · archivo`, action: encodeAction({ kind: 'open', n }), group: n });
    }
    return fila;
  });

/**
 * The hard data that answered.
 *
 * **The warning goes before the value.** Reading "UF 3" and only then
 * "expired in 2024" is exactly the failure mode this prevents: the risk is not
 * no es olvidar un dato, es leer el viejo sin darte cuenta.
 */
function factsBody(hits: FactHit[]): string {
  const lineas = hits.map((h) => {
    const aviso = warningFor(h);
    return `${aviso ? `⚠ ${aviso}.\n` : ''}${h.ref.field.label}: ${renderValue(h.value, h.ref.field.kind)}\n` +
      `   ${contextOf(h)} · ${h.fact.shortId}`;
  });
  // Two live copies of the same datum are not resolved by picking one.
  const conflicto = conflicting(hits)
    ? '\n\nHay dos vigentes que dicen cosas distintas. No elijo por ti.'
    : '';
  return lineas.join('\n\n') + conflicto;
}

export function present(result: Result<Outcome>, caps: Capabilities): Reply[] {
  if (!result.ok) return [failure(result, caps)];
  const v = result.value;

  switch (v.kind) {
    case 'help':
      return [{
        kind: 'text',
        body: [
          'Mándame un archivo —foto, PDF, nota de voz— y lo guardo.',
          'Lo que escribas suelto lo tomo como query: te respondo con lo que tengas guardado.',
          'Para guardar un texto, /capture.',
          '',
          '/capture <texto>   guarda eso como memoria',
          '/ask <pregunta>    responde citando la fuente',
          '/search <algo>     lista lo que coincide',
          '/pending           qué me falta por leer',
          '/review            lo que quedó dudoso',
          '/domains           tus categorías, y /<categoría> para ver una',
          '/create <nombre>: <descripción>    categoría nueva',
          '/describe <cat>: <descripción>     la descripción es lo que clasifica',
          '/rename <cat> <nombre>  ·  /archive <cat>',
          '/merge <de> <a>                    mueve sus memorias y archiva la primera',
          '/propose           categorías que te faltan, según lo que guardaste',
          '/help              esto',
          '',
          'Sobre un resultado: view:N los datos · open:N el archivo · hide:N lo saca de las búsquedas.',
        ].join('\n'),
      }];

    case 'paired':
      return [{
        kind: 'text',
        body: v.displayName
          ? `Listo, ${v.displayName}. Mándame lo que quieras y lo guardo.`
          : 'Listo. Mándame lo que quieras y lo guardo.',
      }];

    case 'saved': {
      const c = v.capture;
      const dedup = c.deduped ? '\nYa lo tenías: es el mismo archivo, pero queda como memoria aparte.' : '';
      // The acknowledgement states the STATUS, not just success. Without this line
      // the wait is invisible; with it, the wait is declared, which is different.
      const leyendo = v.queued
        ? '\nLo estoy leyendo — en un rato lo vas a poder buscar por lo que dice adentro.'
        : '';
      return [{ kind: 'text', body: `Guardado ✓  ${c.shortId}${dedup}${leyendo}` }];
    }

    case 'pending':
      return [{
        kind: 'text',
        body: v.unread === 0
          ? 'No me falta nada por leer.'
          : `Me faltan ${v.unread} por leer. Pregúntame en un rato.`,
      }];

    case 'answer': {
      const a = v.answer;
      // Fact mode: the exact datum, with its validity and its citation. There is
      // no list to page and no passages to offer — there is an answer.
      if (a.facts?.length) return [{ kind: 'text', body: factsBody(a.facts) }];
      // Sources are always shown, even for a good answer: backing is required, and
      // pide respaldo, y en el chat eso significa poder abrir el documento.
      const fuentes = a.sources.map((p, i) =>
        `${i + 1}. ${p.title ?? '(sin título)'}\n   ${day(p.occurredAt ?? p.capturedAt)} · ${p.shortId}`);
      // When the prose was discarded for lack of backing, that gets said — and the
      // sources are shown anyway, since they are verifiable truth. Staying quiet
      // and listing documents lets you believe there was nothing.
      const cabeza = a.text ?? (a.reason === 'ungrounded'
        ? 'No pude darte la cifra sin inventarla. Lo que encontré:'
        : 'No pude responderlo sin inventar. Lo que encontré:');
      return [withOptions(`${cabeza}\n\nde:\n${fuentes.join('\n')}`, porItem(a.sources), caps)];
    }

    case 'detail': {
      // The memory's data, not its transcript. Dumping 1200 characters of a policy
      // here filled the screen with what the file itself says better: that is what
      // the button next to it is for, which sends the whole thing.
      const m = v.memory;
      const lines = [label(m), `${day(m.occurredAt ?? m.capturedAt)} · ${m.shortId}`];

      const ficha = [
        m.domainLabel,
        m.originalFilename ? meaningfulName(m.originalFilename) ?? kindOf(m.mediaType) : kindOf(m.mediaType),
        m.sizeBytes ? size(m.sizeBytes) : null,
      ].filter(Boolean);
      if (ficha.length) lines.push(ficha.join(' · '));
      if (m.tags.length) lines.push(m.tags.map((t) => `#${t}`).join(' '));

      // The header falls back to the excerpt when there is no title, and the excerpt
      // IS the note: without this, a bare note read twice in a row.
      const cabecera = lines[0];
      if (m.note && cabecera !== m.excerpt) lines.push('', `tu nota: ${m.note}`);
      if (m.normalizationError) lines.push('', `⚠ ${m.normalizationError}`);

      // A glimpse of WHAT WAS READ, not the excerpt.
      //
      // The excerpt is note-or-extracted-text on purpose — in a list your own words
      // are easier to recognise than the OCR of the paper — but here the note was
      // already shown above, so using it repeated the whole thing.
      const leido = excerptOf(m.normalizedText, 240);
      if (leido) lines.push('', leido);
      else if (m.sha256 && !m.normalizedAt) lines.push('', 'Todavía no lo he leído.');

      const options: Option[] = m.sha256
        ? [{ label: 'mandarme el original', action: encodeAction({ kind: 'original' }) }]
        : [];
      return [withOptions(lines.join('\n'), options, caps)];
    }

    case 'domain': {
      const d = v.domain;
      const que = v.que === 'created' ? 'Creada' : v.que === 'archived' ? 'Archivada' : 'Actualizada';
      const extra = v.que === 'archived'
        ? ' Sus memorias siguen ahí y siguen buscándose.'
        : v.que === 'created'
          ? ` Mándame algo que calce y va a caer ahí. Para verla: /${d.slug}`
          : '';
      return [{ kind: 'text', body: `${que} /${d.slug} — ${d.label}.${extra}` }];
    }

    case 'merged':
      return [{
        kind: 'text',
        body: `Moví ${v.moved} memoria(s) de ${v.from.label} a ${v.into.label}. ` +
          `${v.from.label} queda archivada; nada se borró.`,
      }];

    case 'hidden':
      return [{ kind: 'text', body: `Listo, ${v.shortId} ya no aparece en los resultados. No se borró.` }];

    case 'file':
      return [{
        kind: 'file',
        filename: v.blob.filename,
        mediaType: v.blob.mediaType,
        bytes: v.blob.bytes,
      }];

    case 'review': {
      if (v.items.length === 0) return [{ kind: 'text', body: 'No hay nada que revisar.' }];
      // Each line says what to do, not just what happened: an inbox that enumerates
      // problems with no way out leaves you where you started.
      const cuerpo = v.items
        .map((m, i) => {
          const salida =
            m.retryable === true ? 'puedo reintentarlo'
            : m.retryable === false ? 'reintentar no ayuda: hay que convertir el archivo o cambiar de carril'
            : 'todavía no sé si reintentar ayuda';
          return `${i + 1}. ${label(m)}\n   ${m.error}\n   ${salida}`;
        })
        .join('\n\n');
      return [withOptions(`Esto quedó dudoso:\n\n${cuerpo}`, porItem(v.items), caps)];
    }

    case 'domains': {
      const cuerpo = v.items
        .map((d) => `/${d.slug}  ${d.label}${d.count ? `  (${d.count})` : ''}`)
        .join('\n');
      return [{ kind: 'text', body: `Tus categorías:\n\n${cuerpo}` }];
    }

    case 'proposals': {
      if (v.items.length === 0) return [{ kind: 'text', body: 'No veo categorías que te falten.' }];
      // Examples are shown so you can decide by looking, not blindly.
      // And it proposes: creating is your call.
      const cuerpo = v.items
        .map((p) => [
          `${p.memoryIds.length} cosas parecen "${p.label}"`,
          `  ${p.description}`,
          ...p.examples.map((e) => `  · ${e}`),
        ].join('\n'))
        .join('\n\n');
      return [{
        kind: 'text',
        body: `Esto es lo que veo que te falta:\n\n${cuerpo}\n\n` +
          'Si alguna te sirve: dm domains propose --accept <slug>',
      }];
    }

    case 'inDomain': {
      if (v.items.length === 0) {
        return [{ kind: 'text', body: `No hay nada en ${v.domain.label} todavía.` }];
      }
      // Ordered by when it HAPPENED, not by when you stored it.
      const cuerpo = v.items
        .map((m, i) => `${i + 1}. ${label(m)}\n   ${day(m.occurredAt ?? m.capturedAt)} · ${m.shortId}`)
        .join('\n');
      return [withOptions(`${v.domain.label}:\n\n${cuerpo}`, porItem(v.items), caps)];
    }

    case 'results':
      return resultados(v, caps);
  }
}

function resultados(
  v: Extract<Outcome, { kind: 'results' }>,
  caps: Capabilities,
): Reply[] {
  // The pending line is not courtesy: a search that says "I do not have it"
  // while an OCR pass is running is lying, and that rate is what matters.
  const leyendo = v.pendientes > 0
    ? `\n\n(${v.pendientes === 1 ? 'Falta 1 cosa' : `Faltan ${v.pendientes} cosas`} por leer — si no aparece, pregúntame en un rato.)`
    : '';

  if (v.items.length === 0) {
    // Asking for "more" and finding none is not the same as not having it: the
    // first is the end of a list, the second an answer about your memory.
    if (v.exhausted) return [{ kind: 'text', body: 'No hay más.' }];
    const options: Option[] = v.offerSave
      ? [{ label: 'guardarlo como nota', action: encodeAction({ kind: 'save' }) }]
      : [];
    return [withOptions(`No lo tengo.${leyendo}`, options, caps)];
  }

  const numbered = v.items
    .map((m, i) => `${i + 1}. ${label(m)}\n   ${day(m.occurredAt ?? m.capturedAt)} · ${m.shortId}`)
    .join('\n');

  const desde = v.offset + 1;
  const hasta = v.offset + v.items.length;
  const head = `${desde}–${hasta} de lo que encontré para "${v.query}":`;

  const options: Option[] = porItem(v.items);
  if (v.hasMore) options.push({ label: 'más', action: encodeAction({ kind: 'more' }) });

  return [withOptions(`${head}\n\n${numbered}${leyendo}`, options, caps)];
}

/** Errors and confirmations. What happened and what to do, without apology. */
function failure(
  result: Extract<Result<unknown>, { ok: false }>,
  caps: Capabilities,
): Reply {
  if (result.kind === 'requires_confirmation') {
    const affected = result.affects.map((a) => `· ${a.label ?? a.id}`).join('\n');
    return withOptions(
      `${result.message}\n${affected}`,
      [
        { label: 'sí, hazlo', action: encodeAction({ kind: 'yes' }) },
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
