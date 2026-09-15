import {
  acceptFactType, answer, archiveDomain, countReview, createDomain, curateMemory, editDomain,
  extractFacts, factsForMemory, fetchBlob, list, listDomains, listFacts, listFactTypes,
  listReview, listSessions, mergeDomains, openSession, proposeFactTypes, purge,
  readBackupConfig, revokeAllSessions, revokeSession, search, setHidden, show,
  createFactType, editFactType, archiveFactType, unreadable,
  type TypeProposal,
} from '../../core/index';
import { findDomain } from '../../core/ops/domains';
import { ok, type Result } from '../../core/result';
import { clearCookie, raw, setCookie, type Ctx, type Route } from './http';

/**
 * The routes, grouped by what they are about.
 *
 * Every one of them is the same shape: read the request, call a core operation,
 * hand back what it returned. There is no logic here that the CLI does not also
 * have, and that is the point — the day a rule lives in a route instead of in
 * `core/`, the three channels stop agreeing (§7).
 *
 * **There is no capture route, and its absence is the design.** §2 says capturing
 * is chat-only: it costs one gesture there and a web form would compete with the
 * only path that already works. Nothing here uploads a file.
 */

const num = (v: string | null, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// ------------------------------------------------------------------ session

const sessionRoutes: Route[] = [
  {
    method: 'POST', path: '/api/session', public: true,
    handler: async ({ deps, req, body }) => {
      const { code } = await body<{ code?: string }>();
      const s = await openSession(deps, String(code ?? ''), {
        userAgent: req.headers['user-agent'] ?? null,
      });
      if (!s.ok) return s;
      // The token is returned exactly once, in a cookie the page cannot read.
      return {
        ...raw(JSON.stringify({ data: { ownerId: s.value.ownerId, expiresAt: s.value.expiresAt } }), {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': setCookie(s.value.token!, s.value.expiresAt),
        }),
      };
    },
  },
  {
    // Public on purpose: "am I logged in?" must be answerable without a session,
    // or the page cannot tell a logged-out visitor from a broken server.
    method: 'GET', path: '/api/session', public: true,
    handler: async ({ deps, actor }) => {
      if (!actor.ownerId) return ok({ authenticated: false });
      const sessions = await listSessions(deps, actor);
      return ok({ authenticated: true, ownerId: actor.ownerId, sessions: sessions.ok ? sessions.value : [] });
    },
  },
  {
    method: 'DELETE', path: '/api/session',
    handler: async ({ deps, actor }) => {
      const r = await revokeAllSessions(deps, actor);
      if (!r.ok) return r;
      return raw(JSON.stringify({ data: r.value }), {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': clearCookie(),
      });
    },
  },
  {
    method: 'DELETE', path: '/api/sessions/:id',
    handler: ({ deps, actor, params }) => revokeSession(deps, actor, params.id!),
  },
];

// ------------------------------------------------------------------ memories

const memoryRoutes: Route[] = [
  {
    method: 'GET', path: '/api/memories',
    handler: async ({ deps, actor, url }) => {
      const q = url.searchParams.get('q');
      const limit = Math.min(num(url.searchParams.get('limit'), 25), 100);
      const offset = num(url.searchParams.get('offset'), 0);
      // Filtered by slug, because a slug is what a URL can carry and what a
      // person has in hand; the core wants the id.
      const slug = url.searchParams.get('domain');
      const domain = slug ? await findDomain(deps.db, actor, slug) : null;
      if (slug && !domain) return ok([]);
      const domainId = domain?.id ?? null;

      // Searching and listing are different operations in the core and stay
      // different here: a search ranks, a list orders by time.
      if (q && q.trim()) {
        return search(deps, actor, { query: q, limit, offset, domainId });
      }
      return list(deps, actor, { limit, offset, domainId });
    },
  },
  {
    method: 'GET', path: '/api/memories/:id',
    handler: async ({ deps, actor, params }) => {
      const d = await show(deps, actor, params.id!);
      if (!d.ok) return d;
      const facts = await factsForMemory(deps.db, actor, d.value.id).catch(() => []);
      return ok({ memory: d.value, facts });
    },
  },
  {
    method: 'PATCH', path: '/api/memories/:id',
    handler: async ({ deps, actor, params, body }) =>
      curateMemory(deps, actor, params.id!, await body()),
  },
  {
    method: 'POST', path: '/api/memories/:id/hide',
    handler: async ({ deps, actor, params, body }) => {
      const { hidden } = await body<{ hidden?: boolean }>();
      return setHidden(deps, actor, params.id!, hidden !== false);
    },
  },
  {
    method: 'DELETE', path: '/api/memories/:id',
    handler: async ({ deps, actor, params, url }) =>
      // Purging without `confirm` returns 409 with what it would destroy, named.
      // The client asks and calls again; nothing here decides for you (§13.8).
      purge(deps, actor, params.id!, { confirm: url.searchParams.get('confirm') === 'true' }),
  },
  {
    method: 'GET', path: '/api/memories/:id/blob',
    handler: async ({ deps, actor, params }) => {
      const b = await fetchBlob(deps, actor, params.id!);
      if (!b.ok) return b;
      return raw(b.value.bytes, {
        'content-type': b.value.mediaType ?? 'application/octet-stream',
        // `inline`, so the browser shows a PDF instead of downloading it: §6.1
        // says opening a document must not cost an extra step.
        'content-disposition': `inline; filename="${encodeURIComponent(b.value.filename ?? 'archivo')}"`,
      });
    },
  },
];

// ------------------------------------------------------------------ domains

const domainRoutes: Route[] = [
  { method: 'GET', path: '/api/domains', handler: async ({ deps, actor }) => ok(await listDomains(deps.db, actor)) },
  {
    method: 'POST', path: '/api/domains',
    handler: async ({ deps, actor, body }) => {
      const input = await body<{ label: string; description: string }>();
      return createDomain(deps.db, actor, input);
    },
  },
  {
    method: 'PATCH', path: '/api/domains/:slug',
    handler: async ({ deps, actor, params, body }) => {
      const patch = await body<{ label?: string; description?: string }>();
      return editDomain(deps.db, actor, params.slug!, patch);
    },
  },
  {
    method: 'POST', path: '/api/domains/:slug/archive',
    handler: ({ deps, actor, params }) => archiveDomain(deps.db, actor, params.slug!),
  },
  {
    method: 'POST', path: '/api/domains/merge',
    handler: async ({ deps, actor, body }) => {
      const { from, into, confirm } = await body<{ from: string; into: string; confirm?: boolean }>();
      return mergeDomains(deps, actor, from, into, { confirm: confirm === true });
    },
  },
];

// ------------------------------------------------------------------ facts

const factRoutes: Route[] = [
  {
    method: 'GET', path: '/api/facts',
    handler: async ({ deps, actor, url }) =>
      ok(await listFacts(deps.db, actor, { includeSuperseded: url.searchParams.get('all') === 'true' })),
  },
  {
    method: 'GET', path: '/api/facts/types',
    handler: async ({ deps, actor, url }) =>
      ok(await listFactTypes(deps.db, actor, { includeInactive: url.searchParams.get('all') === 'true' })),
  },
  {
    method: 'POST', path: '/api/facts/types',
    handler: async ({ deps, actor, body }) => createFactType(deps, actor, await body()),
  },
  {
    method: 'PATCH', path: '/api/facts/types/:slug',
    handler: async ({ deps, actor, params, url, body }) =>
      // Confirmation travels the same way as a purge: without it the server
      // answers 409 saying what the change would decide.
      editFactType(deps, actor, params.slug!, await body(), {
        confirm: url.searchParams.get('confirm') === 'true',
      }),
  },
  {
    method: 'POST', path: '/api/facts/types/:slug/archive',
    handler: ({ deps, actor, params }) => archiveFactType(deps, actor, params.slug!),
  },
  {
    // What no type can read, which is the failure that used to be silent.
    method: 'GET', path: '/api/facts/gaps',
    handler: async ({ deps, actor }) => ok(await unreadable(deps.db, actor)),
  },
  {
    method: 'POST', path: '/api/facts/extract',
    handler: async ({ deps, actor, body }) => {
      const { memoryId } = await body<{ memoryId?: string }>();
      if (!memoryId) return { ok: false, kind: 'invalid', message: 'Falta memoryId.' } as Result<never>;
      return extractFacts(deps, actor, memoryId);
    },
  },
  { method: 'GET', path: '/api/facts/proposals', handler: ({ deps, actor }) => proposeFactTypes(deps, actor) },
  {
    method: 'POST', path: '/api/facts/proposals',
    handler: async ({ deps, actor, body }) => {
      const { proposal, confirm } = await body<{ proposal: TypeProposal; confirm?: boolean }>();
      return acceptFactType(deps, actor, proposal, { confirm: confirm === true });
    },
  },
];

// ------------------------------------------------------------------ el resto

const otherRoutes: Route[] = [
  { method: 'GET', path: '/api/review', handler: ({ deps, actor }) => listReview(deps, actor) },
  {
    method: 'GET', path: '/api/ask',
    handler: ({ deps, actor, url }: Ctx) =>
      answer(deps, actor, { query: url.searchParams.get('q') ?? '', synthesize: true }),
  },
  {
    method: 'GET', path: '/api/overview',
    handler: async ({ deps, actor }) => {
      // One call for the dashboard. Four round trips to paint one screen is how
      // a client ends up with four loading states for one idea.
      const [domains, review, facts, backup, gaps] = await Promise.all([
        listDomains(deps.db, actor),
        countReview(deps.db, actor),
        listFacts(deps.db, actor, {}),
        readBackupConfig(deps, actor),
        unreadable(deps.db, actor),
      ]);
      return ok({
        domains,
        pendingReview: review,
        facts: facts.length,
        backup: backup.ok ? backup.value : null,
        gaps,
      });
    },
  },
];

export const routes: Route[] = [
  ...sessionRoutes,
  ...memoryRoutes,
  ...domainRoutes,
  ...factRoutes,
  ...otherRoutes,
];
