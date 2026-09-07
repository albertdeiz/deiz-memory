import type { Capabilities, Conversation } from '../channel/types';
import type { Actor, MemoryDetail, MemorySummary } from '../domain/types';
import type { Deps } from '../ports';
import { err, ok, type Result } from '../result';
import { capture, type CaptureResult } from '../ops/capture';
import { fetchBlob, search, show, type BlobPayload } from '../ops/query';
import { setHidden } from '../ops/lifecycle';
import { resolveMemoryId } from '../ops/resolve';
import { answer, type Answer } from '../recall/answer';
import { redeemPairingCode } from '../ops/identity';
import { listReview, type ReviewItem } from '../ops/review';
import {
  archiveDomain, createDomain, editDomain, findDomain, listDomains, mergeDomains,
  type Domain,
} from '../ops/domains';
import { proposeDomains, type Proposal } from '../classify/emergent';
import { list } from '../ops/query';
import type { Intent } from './intent';
import type { Target } from './actions';
import {
  confirmIsFresh, pendingCount, readSession, writeSession,
  type ChatSession, type Pending,
} from './session';

/** Five per page. Never a wall of text. */
export const PAGE = 5;

/**
 * What happened, as data. Presentation decides how it looks; there is not one
 * string here meant for a person — the core returns data and never prose.
 */
export type Outcome =
  | { kind: 'paired'; displayName: string | null }
  | { kind: 'saved'; capture: CaptureResult; queued: boolean }
  | {
      kind: 'results';
      query: string;
      items: MemorySummary[];
      offset: number;
      hasMore: boolean;
      /** What has not been read yet. Turns "I do not have it" into the truth. */
      pendientes: number;
      /** Text that can be stored if the search found nothing. */
      offerSave: string | null;
      /** "More" was asked for and none is left: different from "I do not have it". */
      exhausted: boolean;
    }
  | { kind: 'answer'; answer: Answer; query: string }
  | { kind: 'detail'; memory: MemoryDetail }
  | { kind: 'file'; blob: BlobPayload }
  | { kind: 'pending'; unread: number }
  | { kind: 'review'; items: ReviewItem[] }
  | { kind: 'domains'; items: Domain[] }
  | { kind: 'proposals'; items: Proposal[] }
  | { kind: 'inDomain'; domain: Domain; items: MemorySummary[] }
  | { kind: 'hidden'; shortId: string }
  | { kind: 'domain'; domain: Domain; que: 'created' | 'updated' | 'archived' }
  | { kind: 'merged'; from: Domain; into: Domain; moved: number }
  | { kind: 'help' };

export interface RouteInput {
  conv: Conversation;
  intent: Intent;
  caps: Capabilities;
  now: Date;
  displayName?: string | null;
}

/**
 * From the verb to the core operation.
 *
 * It demands an `Actor`, and that signature is owner isolation made structural:
 * with no linked identity there is no actor, and with no actor there is no path
 * to call anything. It stops depending on someone remembering a WHERE clause.
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
 * Records the list just shown, so "view 2" means the second of THAT list.
 *
 * Done here, in one place, and not in each branch. The category listing numbered
 * its results and offered the buttons without ever writing the session: pressing
 * 2 returned the second of the previous *search*. A real document, of something
 * else entirely — the most expensive silent failure this can have, because it
 * looks like an answer.
 *
 * The root cause was not the forgotten branch: it was that **numbering and
 * recording lived in different files**, so the next list anyone adds repeats the
 * bug. Here the recording hangs off the shape of the outcome, and a new list is
 * covered without anyone remembering to.
 */
async function registerList(
  deps: Deps,
  actor: Actor,
  input: RouteInput,
  r: Extract<Result<Outcome>, { ok: true }>,
): Promise<Result<Outcome>> {
  const v = r.value;

  // Una lista numerada nueva reemplaza a la anterior. `resultados` y
  // The answer path writes its own — carrying its query and offset, which are
  // not known here — so they are left alone.
  const ids = numbered(v);
  if (ids) {
    await writeSession(deps.db, input.conv, actor.ownerId,
      { lastQuery: null, lastOffset: 0, pending: { ids } }, input.now);
    return r;
  }

  // Opening a detail does not change the list: it moves the focus. `ids` is kept
  // so "view 3" still means the third of what you are looking at.
  if (v.kind === 'detail') {
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
 * The ids of a numbered list, in the same order they are shown.
 *
 * One case per listing the bot hands over with actions. Search results are
 * not here because that path writes its own, carrying the query and offset
 * so paging keeps working; duplicating it here would clobber it.
 */
function numbered(v: Outcome): string[] | null {
  switch (v.kind) {
    case 'inDomain':
    case 'review':
      return v.items.map((m) => m.id);
    case 'answer':
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
    case 'help':
      return ok({ kind: 'help' });

    case 'pair':
      // Already inside; pairing again breaks nothing but is not needed either.
      return ok({ kind: 'paired', displayName: input.displayName ?? null });

    case 'pending':
      return ok({ kind: 'pending', unread: await pendingCount(deps.db, actor.ownerId) });

    case 'domains':
      return ok({ kind: 'domains', items: await listDomains(deps.db, actor) });

    case 'createDomain':
      return doCreateDomain(deps, actor, input, intent.label, intent.description, false);

    case 'describeDomain': {
      const r = await editDomain(deps.db, actor, intent.ref, { description: intent.description });
      return r.ok ? ok({ kind: 'domain', domain: r.value, que: 'updated' }) : r;
    }

    case 'renameDomain': {
      const r = await editDomain(deps.db, actor, intent.ref, { label: intent.label });
      return r.ok ? ok({ kind: 'domain', domain: r.value, que: 'updated' }) : r;
    }

    case 'archiveDomain': {
      const r = await archiveDomain(deps.db, actor, intent.ref);
      return r.ok ? ok({ kind: 'domain', domain: r.value, que: 'archived' }) : r;
    }

    case 'mergeDomains':
      return doMerge(deps, actor, input, intent.from, intent.into, false);

    case 'propose': {
      const r = await proposeDomains(deps, actor);
      return r.ok ? ok({ kind: 'proposals', items: r.value }) : r;
    }

    case 'inDomain': {
      const d = await findDomain(deps.db, actor, intent.ref);
      // Any unknown /whatever lands here, so the message has to serve both the
      // person who mistyped a category and the one who tried a command that
      // does not exist. Naming both paths costs one line.
      if (!d) {
        return err('not_found',
          `No conozco "/${intent.ref}". Mira /domains para las categorías, o /help para los comandos.`);
      }
      const r = await list(deps, actor, { domainId: d.id, limit: PAGE });
      return r.ok ? ok({ kind: 'inDomain', domain: d, items: r.value }) : r;
    }

    case 'review': {
      const r = await listReview(deps, actor, { limit: PAGE });
      return r.ok ? ok({ kind: 'review', items: r.value }) : r;
    }

    case 'capture':
      return doCapture(deps, actor, input, null);

    case 'recall': {
      // A question is answered; a keyword search is listed.
      //
      // The difference matters: asking for a deductible wants the datum with
      // its citation, not five documents to look through. An explicit search
      // wants the list. The intent classifier already told them apart, so all
      // that is needed here is to respect it.
      if (intent.guessed && deps.classifier) {
        const r = await answer(deps, actor, { query: intent.query, synthesize: true });
        if (!r.ok) return r;
        // With no drafted answer it falls back to the list: the passages are
        // useful anyway, and better than an "I could not" when material exists.
        //
        // With one exception: if the prose was discarded **on purpose** — no
        // citation, or a figure absent from what was read — the bare list lies
        // by omission. The person asked for a number and gets documents without
        // learning the bot declined to give it. That gets said.
        const rechazada = r.value.reason === 'no_citation' || r.value.reason === 'ungrounded';
        const hechos = (r.value.facts?.length ?? 0) > 0;
        // The session is written by registerList, like any other listing.
        if (r.value.text || rechazada || hechos) {
          return ok({ kind: 'answer', answer: r.value, query: intent.query });
        }
      }
      return doSearch(deps, actor, input, intent.query, 0, intent.guessed);
    }

    case 'action':
      return doAction(deps, actor, input, session);
  }
}

/**
 * Creating and merging share a shape: they try, and if the core asks for
 * confirmation they store the operation in the session so a yes can repeat it.
 *
 * The whole operation is stored rather than a marker, so the yes re-runs exactly
 * the same path with confirmation set. A second path that "applies the confirmed
 * thing" could drift from the first without anyone noticing.
 */
async function doCreateDomain(
  deps: Deps, actor: Actor, input: RouteInput,
  label: string, description: string, confirm: boolean,
): Promise<Result<Outcome>> {
  const r = await createDomain(deps.db, actor, { label, description, confirm });
  if (r.ok) {
    await writeSession(deps.db, input.conv, actor.ownerId, { pending: null }, input.now);
    return ok({ kind: 'domain', domain: r.value, que: 'created' });
  }
  if (r.kind === 'requires_confirmation') {
    await writeSession(deps.db, input.conv, actor.ownerId, {
      pending: {
        confirm: { label, op: 'createDomain', args: { label, description },
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
    return ok({ kind: 'merged', from: r.value.from, into: r.value.into, moved: r.value.moved });
  }
  if (r.kind === 'requires_confirmation') {
    await writeSession(deps.db, input.conv, actor.ownerId, {
      pending: { confirm: { label: `${from} → ${into}`, op: 'mergeDomains', args: { from, into },
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
  const text = overrideText ?? (intent.verb === 'capture' ? intent.text : null);
  const attachment = intent.verb === 'capture' ? intent.attachment : null;

  let bytes: Buffer | null = null;
  let filename: string | null = null;

  if (attachment) {
    // Compared BEFORE downloading. On some platforms this is not a degradation
    // but a wall: the bot cannot ask for a larger file.
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
      // The memory is not created: a row pointing at a blob that does not exist is
      // worse than not having the row at all, same as at capture time.
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

  // Capturing closes whatever was on screen: the old list no longer applies.
  await writeSession(deps.db, conv, actor.ownerId, { pending: null }, now);

  // There is only something to read if a file arrived; bare text is already text.
  const queued = res.value.sha256 !== null;
  return ok({ kind: 'saved', capture: res.value, queued });
}

async function doSearch(
  deps: Deps,
  actor: Actor,
  input: RouteInput,
  query: string,
  offset: number,
  guessed: boolean,
): Promise<Result<Outcome>> {
  const { conv, now } = input;
  const q = query.trim();
  if (!q) return err('invalid', 'Dime qué buscar.');

  // Six are asked for to show five: the sixth is what says whether there is
  // more, with no count(*) and no keyset cursor at this scale.
  const res = await search(deps, actor, { query: q, limit: PAGE + 1, offset });
  if (!res.ok) return res;

  const hasMore = res.value.length > PAGE;
  const items = res.value.slice(0, PAGE);
  const pendientes = await pendingCount(deps.db, actor.ownerId);

  const pending: Pending = { ids: items.map((m) => m.id) };
  // Saving is only offered when WE decided this was a question. An explicit
  // search meant search, and "more" meant the next page: offering to store
  // the search term as a note would be absurd, and would do it with text
  // the person never meant to store.
  const exhausted = offset > 0 && items.length === 0;
  const offerSave = guessed && !exhausted && items.length === 0 ? q : null;
  if (offerSave) pending.save = offerSave;

  await writeSession(
    deps.db, conv, actor.ownerId,
    { lastQuery: q, lastOffset: offset, pending },
    now,
  );

  return ok({ kind: 'results', query: q, items, offset, hasMore, pendientes, offerSave, exhausted });
}

/**
 * The memory a targeted action points at.
 *
 * The two ways of pointing meet here and nowhere else. An index is looked up in
 * the list the session recorded; an id is resolved like any other reference —
 * by prefix, filtered by owner, and it does not care whether a list is on
 * screen. That is the whole point of a button carrying one: it stays right after
 * the list it came from is long gone.
 */
async function aim(
  deps: Deps,
  actor: Actor,
  session: ChatSession | null,
  target: Target,
): Promise<Result<string>> {
  if (target.by === 'id') return resolveMemoryId(deps.db, actor, target.id);
  const id = (session?.pending?.ids ?? [])[target.n - 1];
  return id
    ? ok(id)
    : err('invalid', `No hay un ${target.n} en la última lista. Busca de nuevo.`);
}

async function doAction(
  deps: Deps,
  actor: Actor,
  input: RouteInput,
  session: ChatSession | null,
): Promise<Result<Outcome>> {
  const { intent, conv, now } = input;
  if (intent.verb !== 'action') return err('invalid', 'No entendí.');
  const a = intent.action;

  switch (a.kind) {
    case 'more': {
      if (!session?.lastQuery) return err('invalid', 'No hay una búsqueda abierta.');
      return doSearch(deps, actor, input, session.lastQuery, session.lastOffset + PAGE, false);
    }

    case 'save': {
      const text = session?.pending?.save;
      if (!text) return err('invalid', 'No hay nada pendiente de guardar.');
      return doCapture(deps, actor, { ...input, intent: { verb: 'capture', text, attachment: null } }, text);
    }

    case 'hide': {
      const t = await aim(deps, actor, session, a.target);
      if (!t.ok) return t;
      // Hide, not purge: the chat deletes nothing irreversibly. That is what
      // the terminal is for, with its confirmation and its audit log.
      const r = await setHidden(deps, actor, t.value, true);
      return r.ok ? ok({ kind: 'hidden', shortId: r.value.shortId }) : r;
    }

    case 'view':
    case 'open': {
      const t = await aim(deps, actor, session, a.target);
      if (!t.ok) return t;
      if (a.kind === 'view') {
        const d = await show(deps, actor, t.value);
        return d.ok ? ok({ kind: 'detail', memory: d.value }) : d;
      }
      const b = await fetchBlob(deps, actor, t.value);
      return b.ok ? ok({ kind: 'file', blob: b.value }) : b;
    }

    case 'original': {
      // The file of what you are looking at, not of a position in the list.
      const id = session?.pending?.viewing;
      if (!id) return err('invalid', 'No estás mirando nada. Abre algo primero.');
      const b = await fetchBlob(deps, actor, id);
      return b.ok ? ok({ kind: 'file', blob: b.value }) : b;
    }

    case 'yes':
    case 'no': {
      if (!confirmIsFresh(session?.pending ?? null, now)) {
        // A yes arriving half an hour late does not refer to what the person
        // thinks. Expiring it is safer than guessing what it pointed at.
        return err('invalid', 'No hay nada esperando confirmación.');
      }
      const c = session!.pending!.confirm!;
      await writeSession(deps.db, conv, actor.ownerId, { pending: null }, now);
      if (a.kind === 'no') return err('invalid', `Listo, no hago nada con "${c.label}".`);

      // The SAME operation is repeated, with confirmation set.
      if (c.op === 'createDomain') {
        return doCreateDomain(deps, actor, input, c.args.label ?? '', c.args.description ?? '', true);
      }
      return doMerge(deps, actor, input, c.args.from ?? '', c.args.into ?? '', true);
    }

  }
}

/** Links a new identity. The only thing here that runs with no actor. */
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
  return ok({ kind: 'paired', displayName: r.value.displayName });
}
