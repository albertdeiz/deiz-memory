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
import {
  archiveDomain, createDomain, editDomain, findDomain, listDomains, mergeDomains,
  type Domain,
} from '../ops/domains.js';
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
  | { kind: 'dominio'; domain: Domain; que: 'creado' | 'editado' | 'archivado' }
  | { kind: 'fusionado'; from: Domain; into: Domain; moved: number }
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
  const r = await dispatch(deps, actor, input);
  return r.ok ? registerList(deps, actor, input, r) : r;
}

/**
 * Deja anotada la lista que se acaba de mostrar, para que "ver 2" signifique el
 * segundo de ESA lista.
 *
 * Se hace acá, en un solo lugar, y no en cada rama. `enDominio` numeraba sus
 * resultados y ofrecía los botones `ver N` sin escribir la sesión nunca: al
 * pulsar el 2 salía el segundo de la búsqueda anterior. Un documento real, de
 * otra cosa — el fallo silencioso más caro que puede tener esto, porque parece
 * una respuesta.
 *
 * La causa de fondo no era la rama olvidada: era que **numerar y registrar
 * vivían en archivos distintos**, así que la próxima lista que alguien agregue
 * repite el bug. Acá el registro cuelga de la forma del `Outcome`, y una lista
 * nueva queda cubierta sin que nadie se acuerde.
 */
async function registerList(
  deps: Deps,
  actor: Actor,
  input: RouteInput,
  r: Extract<Result<Outcome>, { ok: true }>,
): Promise<Result<Outcome>> {
  const v = r.value;

  // Una lista numerada nueva reemplaza a la anterior. `resultados` y
  // `respuesta` ya escribieron la suya —con su `lastQuery` y su offset, que acá
  // no se conocen—, así que no se tocan.
  const ids = numbered(v);
  if (ids) {
    await writeSession(deps.db, input.conv, actor.ownerId,
      { lastQuery: null, lastOffset: 0, pending: { ids } }, input.now);
    return r;
  }

  // Abrir un detalle no cambia la lista: mueve el foco. Se conserva `ids` para
  // que "ver 3" siga significando el tercero de lo que estás mirando.
  if (v.kind === 'detalle') {
    const prev = await readSession(deps.db, input.conv);
    await writeSession(deps.db, input.conv, actor.ownerId,
      {
        lastQuery: prev?.lastQuery ?? null,
        lastOffset: prev?.lastOffset ?? 0,
        pending: { ...(prev?.pending ?? {}), viewing: v.memory.id },
      },
      input.now);
  }
  return r;
}

/**
 * Los ids de una lista numerada, en el mismo orden en que se muestran.
 *
 * Un caso por cada listado que el bot entrega con acciones. `resultados` no
 * está porque `doSearch` escribe la suya —lleva además la consulta y el offset
 * para que "more" siga paginando—, y duplicarla acá la pisaría.
 */
function numbered(v: Outcome): string[] | null {
  switch (v.kind) {
    case 'enDominio':
    case 'revisar':
      return v.items.map((m) => m.id);
    case 'respuesta':
      return v.answer.sources.map((p) => p.memoryId);
    default:
      return null;
  }
}

async function dispatch(
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

    case 'crearDominio':
      return doCreateDomain(deps, actor, input, intent.label, intent.description, false);

    case 'describirDominio': {
      const r = await editDomain(deps.db, actor, intent.ref, { description: intent.description });
      return r.ok ? ok({ kind: 'dominio', domain: r.value, que: 'editado' }) : r;
    }

    case 'renombrarDominio': {
      const r = await editDomain(deps.db, actor, intent.ref, { label: intent.label });
      return r.ok ? ok({ kind: 'dominio', domain: r.value, que: 'editado' }) : r;
    }

    case 'archivarDominio': {
      const r = await archiveDomain(deps.db, actor, intent.ref);
      return r.ok ? ok({ kind: 'dominio', domain: r.value, que: 'archivado' }) : r;
    }

    case 'fusionarDominios':
      return doMerge(deps, actor, input, intent.from, intent.into, false);

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
          `No conozco "/${intent.ref}". Mira /domains para las categorías, o /help para los comandos.`);
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
      // cita, no cinco documentos donde buscarlo. `/search poliza` quiere la
      // lista. El clasificador de intención ya distinguió las dos (§5), así que
      // acá solo hay que respetarlo.
      if (intent.adivinado && deps.classifier) {
        const r = await answer(deps, actor, { query: intent.query, synthesize: true });
        if (!r.ok) return r;
        // Sin respuesta redactada se cae a la lista: los pasajes sirven igual,
        // y es mejor que un "no pude" cuando sí hay material.
        //
        // Con una excepción: si la prosa se descartó **a propósito** —sin cita,
        // o con una cifra que no está en lo que se leyó— la lista sola miente
        // por omisión. La persona preguntó un número y recibe documentos sin
        // enterarse de que el bot se negó a dárselo. Eso se dice.
        const rechazada = r.value.reason === 'sin_cita' || r.value.reason === 'sin_respaldo';
        // La sesión la escribe `registerList`, como con cualquier otro listado.
        if (r.value.text || rechazada) {
          return ok({ kind: 'respuesta', answer: r.value, consulta: intent.query });
        }
      }
      return doSearch(deps, actor, input, intent.query, 0, intent.adivinado);
    }

    case 'accion':
      return doAction(deps, actor, input, session);
  }
}

/**
 * Crear y fusionar comparten forma: intentan, y si el core pide confirmación,
 * guardan la operación en la sesión para poder repetirla con un "sí".
 *
 * Se guarda la operación entera y no un marcador, así que el sí reejecuta
 * exactamente el mismo camino con `confirm: true`. Un segundo camino que
 * "aplica lo confirmado" podría divergir del primero sin que nadie lo note.
 */
async function doCreateDomain(
  deps: Deps, actor: Actor, input: RouteInput,
  label: string, description: string, confirm: boolean,
): Promise<Result<Outcome>> {
  const r = await createDomain(deps.db, actor, { label, description, confirm });
  if (r.ok) {
    await writeSession(deps.db, input.conv, actor.ownerId, { pending: null }, input.now);
    return ok({ kind: 'dominio', domain: r.value, que: 'creado' });
  }
  if (r.kind === 'requires_confirmation') {
    await writeSession(deps.db, input.conv, actor.ownerId, {
      pending: {
        confirm: { label, op: 'crearDominio', args: { label, description },
                   askedAt: input.now.toISOString() },
      },
    }, input.now);
  }
  return r;
}

async function doMerge(
  deps: Deps, actor: Actor, input: RouteInput,
  from: string, into: string, confirm: boolean,
): Promise<Result<Outcome>> {
  const r = await mergeDomains(deps, actor, from, into, { confirm });
  if (r.ok) {
    await writeSession(deps.db, input.conv, actor.ownerId, { pending: null }, input.now);
    return ok({ kind: 'fusionado', from: r.value.from, into: r.value.into, moved: r.value.moved });
  }
  if (r.kind === 'requires_confirmation') {
    await writeSession(deps.db, input.conv, actor.ownerId, {
      pending: { confirm: { label: `${from} → ${into}`, op: 'fusionar', args: { from, into },
                            askedAt: input.now.toISOString() } },
    }, input.now);
  }
  return r;
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
  // era una pregunta. Si escribió /search quería buscar, y si pidió "más"
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

    case 'original': {
      // El archivo de lo que estás mirando, no el de un puesto de la lista.
      const id = session?.pending?.viewing;
      if (!id) return err('invalid', 'No estás mirando nada. Abre algo primero.');
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
      const c = session!.pending!.confirm!;
      await writeSession(deps.db, conv, actor.ownerId, { pending: null }, now);
      if (a.kind === 'no') return err('invalid', `Listo, no hago nada con "${c.label}".`);

      // Se repite la MISMA operación con confirm activo.
      if (c.op === 'crearDominio') {
        return doCreateDomain(deps, actor, input, c.args.label ?? '', c.args.description ?? '', true);
      }
      return doMerge(deps, actor, input, c.args.from ?? '', c.args.into ?? '', true);
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
