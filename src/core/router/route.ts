import type { Capabilities, Conversation } from '../channel/types.js';
import type { Actor, MemoryDetail, MemorySummary } from '../domain/types.js';
import type { Deps } from '../ports.js';
import { err, ok, type Result } from '../result.js';
import { capture, type CaptureResult } from '../ops/capture.js';
import { fetchBlob, search, show, type BlobPayload } from '../ops/query.js';
import { setHidden } from '../ops/lifecycle.js';
import { answer, type Answer } from '../recall/answer.js';
import { redeemPairingCode } from '../ops/identity.js';
import { listReview, type ReviewItem } from '../ops/review.js';
import { findDomain, listDomains, type Domain } from '../ops/domains.js';
import { proposeDomains, type Proposal } from '../classify/emergent.js';
import { list } from '../ops/query.js';
import type { Intent } from './intent.js';
import {
  confirmIsFresh, pendingCount, readSession, writeSession,
  type ChatSession, type Pending,
} from './session.js';

/** Cinco por página, como manda §6.1. Nunca un muro de texto. */
export const PAGE = 5;

/**
 * Lo que pasó, en datos. `present.ts` decide cómo se ve; acá no hay una sola
 * cadena destinada a una persona — el core devuelve datos y nunca prosa.
 */
export type Outcome =
  | { kind: 'pareado'; displayName: string | null }
  | { kind: 'guardado'; capture: CaptureResult; enCola: boolean }
  | {
      kind: 'resultados';
      consulta: string;
      items: MemorySummary[];
      offset: number;
      hayMas: boolean;
      /** Lo que todavía no se ha leído. Convierte un "no lo tengo" en verdad. */
      pendientes: number;
      /** Texto que se puede guardar si la búsqueda no encontró nada (§5). */
      ofreceGuardar: string | null;
      /** Se pidió "más" y ya no queda: distinto de "no lo tengo". */
      agotado: boolean;
    }
  | { kind: 'respuesta'; answer: Answer; consulta: string }
  | { kind: 'detalle'; memory: MemoryDetail }
  | { kind: 'archivo'; blob: BlobPayload }
  | { kind: 'pendientes'; sinLeer: number }
  | { kind: 'revisar'; items: ReviewItem[] }
  | { kind: 'dominios'; items: Domain[] }
  | { kind: 'propuestas'; items: Proposal[] }
  | { kind: 'enDominio'; domain: Domain; items: MemorySummary[] }
  | { kind: 'ocultada'; shortId: string }
  | { kind: 'ayuda' };

export interface RouteInput {
  conv: Conversation;
  intent: Intent;
  caps: Capabilities;
  now: Date;
  displayName?: string | null;
}

/**
 * Del verbo a la operación del core.
 *
 * Exige un `Actor`, y esa firma es la regla dura 9 hecha estructura: sin
 * identidad vinculada no hay Actor, y sin Actor no existe el camino para llamar
 * a nada. Deja de depender de que alguien se acuerde de un WHERE.
 */
export async function route(
  deps: Deps,
  actor: Actor,
  input: RouteInput,
): Promise<Result<Outcome>> {
  const session = await readSession(deps.db, input.conv);
  const { intent } = input;

  switch (intent.verb) {
    case 'ayuda':
      return ok({ kind: 'ayuda' });

    case 'parear':
      // Ya está adentro; volver a parear no rompe nada pero tampoco hace falta.
      return ok({ kind: 'pareado', displayName: input.displayName ?? null });

    case 'pendientes':
      return ok({ kind: 'pendientes', sinLeer: await pendingCount(deps.db, actor.ownerId) });

    case 'dominios':
      return ok({ kind: 'dominios', items: await listDomains(deps.db, actor) });

    case 'proponer': {
      const r = await proposeDomains(deps, actor);
      return r.ok ? ok({ kind: 'propuestas', items: r.value }) : r;
    }

    case 'enDominio': {
      const d = await findDomain(deps.db, actor, intent.ref);
      // Cualquier /loquesea cae acá, así que el mensaje tiene que servir tanto
      // a quien se equivocó de categoría como a quien probó un comando que no
      // existe. Nombrar los dos caminos cuesta una línea.
      if (!d) {
        return err('not_found',
          `No conozco "/${intent.ref}". Mira /dominios para las categorías, o /ayuda para los comandos.`);
      }
      const r = await list(deps, actor, { domainId: d.id, limit: PAGE });
      return r.ok ? ok({ kind: 'enDominio', domain: d, items: r.value }) : r;
    }

    case 'revisar': {
      const r = await listReview(deps, actor, { limit: PAGE });
      return r.ok ? ok({ kind: 'revisar', items: r.value }) : r;
    }

    case 'capturar':
      return doCapture(deps, actor, input, null);

    case 'recordar': {
      // Una pregunta se responde; una búsqueda por palabras se lista.
      //
      // La diferencia importa: "¿cuál es mi deducible?" quiere el dato con su
      // cita, no cinco documentos donde buscarlo. `/buscar poliza` quiere la
      // lista. El clasificador de intención ya distinguió las dos (§5), así que
      // acá solo hay que respetarlo.
      if (intent.adivinado && deps.classifier) {
        const r = await answer(deps, actor, { query: intent.query, synthesize: true });
        if (!r.ok) return r;
        // Sin respuesta redactada se cae a la lista: los pasajes sirven igual,
        // y es mejor que un "no pude" cuando sí hay material.
        if (r.value.text) {
          await writeSession(deps.db, input.conv, actor.ownerId,
            { lastQuery: intent.query, lastOffset: 0,
              pending: { ids: r.value.sources.map((p) => p.memoryId) } }, input.now);
          return ok({ kind: 'respuesta', answer: r.value, consulta: intent.query });
        }
      }
      return doSearch(deps, actor, input, intent.query, 0, intent.adivinado);
    }

    case 'accion':
      return doAction(deps, actor, input, session);
  }
}

async function doCapture(
  deps: Deps,
  actor: Actor,
  input: RouteInput,
  overrideText: string | null,
): Promise<Result<Outcome>> {
  const { intent, caps, conv, now } = input;
  const text = overrideText ?? (intent.verb === 'capturar' ? intent.text : null);
  const attachment = intent.verb === 'capturar' ? intent.attachment : null;

  let bytes: Buffer | null = null;
  let filename: string | null = null;

  if (attachment) {
    // Se compara ANTES de bajar. En Telegram esto no es una degradación, es un
    // muro: no hay forma de que el bot pida un archivo más grande.
    if (attachment.sizeBytes !== null && attachment.sizeBytes > caps.maxDownloadBytes) {
      const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
      return err(
        'invalid',
        `Ese archivo pesa ${mb(attachment.sizeBytes)} y por este canal solo puedo recibir ` +
          `hasta ${mb(caps.maxDownloadBytes)}. Mándamelo por "dm capture" desde el computador.`,
      );
    }
    try {
      bytes = await attachment.fetch();
    } catch (e) {
      // No se crea la memoria: una fila apuntando a un blob que no existe es
      // peor que no tener la fila (el mismo criterio que ya está en capture.ts).
      return err('invalid', `No pude bajar el archivo: ${e instanceof Error ? e.message : String(e)}`);
    }
    filename = attachment.filename;
  }

  const res = await capture(deps, actor, {
    bytes,
    text,
    filename,
    source: conv.channel === 'telegram' ? 'telegram' : 'manual',
  });
  if (!res.ok) return res;

  // Capturar cierra lo que hubiera en pantalla: la lista vieja ya no aplica.
  await writeSession(deps.db, conv, actor.ownerId, { pending: null }, now);

  // Solo hay algo que leer si vino un archivo; un texto suelto ya es texto.
  const enCola = res.value.sha256 !== null;
  return ok({ kind: 'guardado', capture: res.value, enCola });
}

async function doSearch(
  deps: Deps,
  actor: Actor,
  input: RouteInput,
  consulta: string,
  offset: number,
  adivinado: boolean,
): Promise<Result<Outcome>> {
  const { conv, now } = input;
  const q = consulta.trim();
  if (!q) return err('invalid', 'Dime qué buscar.');

  // Se piden seis para mostrar cinco: el sexto es el que dice si hay más, sin
  // un count(*) ni un cursor de keyset que a esta escala no compran nada.
  const res = await search(deps, actor, { query: q, limit: PAGE + 1, offset });
  if (!res.ok) return res;

  const hayMas = res.value.length > PAGE;
  const items = res.value.slice(0, PAGE);
  const pendientes = await pendingCount(deps.db, actor.ownerId);

  const pending: Pending = { ids: items.map((m) => m.id) };
  // Solo se ofrece guardar cuando fuimos NOSOTROS los que decidimos que esto
  // era una pregunta. Si escribió /buscar quería buscar, y si pidió "más"
  // quería la página siguiente: ofrecerle guardar "deducible" como nota sería
  // absurdo, y encima lo haría con un texto que él nunca quiso guardar.
  const agotado = offset > 0 && items.length === 0;
  const ofreceGuardar = adivinado && !agotado && items.length === 0 ? q : null;
  if (ofreceGuardar) pending.save = ofreceGuardar;

  await writeSession(
    deps.db, conv, actor.ownerId,
    { lastQuery: q, lastOffset: offset, pending },
    now,
  );

  return ok({ kind: 'resultados', consulta: q, items, offset, hayMas, pendientes, ofreceGuardar, agotado });
}

async function doAction(
  deps: Deps,
  actor: Actor,
  input: RouteInput,
  session: ChatSession | null,
): Promise<Result<Outcome>> {
  const { intent, conv, now } = input;
  if (intent.verb !== 'accion') return err('invalid', 'No entendí.');
  const a = intent.action;

  switch (a.kind) {
    case 'mas': {
      if (!session?.lastQuery) return err('invalid', 'No hay una búsqueda abierta.');
      return doSearch(deps, actor, input, session.lastQuery, session.lastOffset + PAGE, false);
    }

    case 'guardar': {
      const text = session?.pending?.save;
      if (!text) return err('invalid', 'No hay nada pendiente de guardar.');
      return doCapture(deps, actor, { ...input, intent: { verb: 'capturar', text, attachment: null } }, text);
    }

    case 'ocultar': {
      const ids = session?.pending?.ids ?? [];
      const id = ids[a.n - 1];
      if (!id) return err('invalid', `No hay un ${a.n} en la última lista.`);
      // Ocultar y no purgar: el chat no borra nada de forma irreversible. Para
      // eso está la terminal, con su confirmación y su registro de auditoría.
      const r = await setHidden(deps, actor, id, true);
      return r.ok ? ok({ kind: 'ocultada', shortId: r.value.shortId }) : r;
    }

    case 'ver':
    case 'abrir': {
      const ids = session?.pending?.ids ?? [];
      const id = ids[a.n - 1];
      if (!id) {
        return err('invalid', `No hay un ${a.n} en la última lista. Busca de nuevo.`);
      }
      if (a.kind === 'ver') {
        const d = await show(deps, actor, id);
        return d.ok ? ok({ kind: 'detalle', memory: d.value }) : d;
      }
      const b = await fetchBlob(deps, actor, id);
      return b.ok ? ok({ kind: 'archivo', blob: b.value }) : b;
    }

    case 'si':
    case 'no': {
      if (!confirmIsFresh(session?.pending ?? null, now)) {
        // Un "sí" que llega media hora tarde no se refiere a lo que la persona
        // cree. Vencerlo es más seguro que adivinar a qué apuntaba.
        return err('invalid', 'No hay nada esperando confirmación.');
      }
      await writeSession(deps.db, conv, actor.ownerId, { pending: null }, now);
      return err('invalid', 'Todavía no hay acciones que confirmar por chat.');
    }

  }
}

/** Vincula una identidad nueva. Vive acá porque es lo único que corre sin Actor. */
export async function pair(
  deps: Deps,
  conv: Conversation,
  externalUserId: string,
  code: string,
  now: Date,
  displayName: string | null,
): Promise<Result<Outcome>> {
  const r = await redeemPairingCode(deps.db, conv.channel, externalUserId, code, now, displayName);
  if (!r.ok) return r;
  return ok({ kind: 'pareado', displayName: r.value.displayName });
}
