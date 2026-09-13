import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Actor } from '../../core/domain/types';
import type { Deps } from '../../core/ports';
import { actorForToken } from '../../core/ops/session';
import type { Result } from '../../core/result';

/**
 * The HTTP plumbing, and nothing about what the routes do.
 *
 * This file exists so every handler can be a function from a request to a
 * `Result` and stay as ignorant of HTTP as the core is of the CLI. The status
 * codes live here, in one table, because scattering them is how two endpoints
 * end up disagreeing about what "not found" means.
 */

export const COOKIE = 'dm_session';

/** Result kinds to status codes. The whole mapping, in one place. */
const STATUS: Record<string, number> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  ambiguous: 409,
  // A confirmation is not an error and not a success: it is the server saying
  // "ask, then call me again". 409 with the affected items named is the same
  // shape the CLI turns into --yes and the chat into a button (§7).
  requires_confirmation: 409,
};

export interface Ctx {
  deps: Deps;
  actor: Actor;
  req: IncomingMessage;
  url: URL;
  params: Record<string, string>;
  body: <T>() => Promise<T>;
}

export type Handler = (ctx: Ctx) => Promise<Result<unknown> | RawResponse>;

/** For the one route that returns bytes instead of data. */
export interface RawResponse {
  raw: true;
  status?: number;
  headers?: Record<string, string>;
  body: Buffer | string;
}

export const raw = (body: Buffer | string, headers: Record<string, string> = {}): RawResponse =>
  ({ raw: true, body, headers });

export interface Route {
  method: string;
  /** `/api/memories/:id` — one level of pattern, which is all this needs. */
  path: string;
  handler: Handler;
  /** Only the session routes. Everything else needs an Actor, by construction. */
  public?: boolean;
}

const parseCookies = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
};

const match = (pattern: string, path: string): Record<string, string> | null => {
  const p = pattern.split('/').filter(Boolean);
  const q = path.split('/').filter(Boolean);
  if (p.length !== q.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i += 1) {
    const seg = p[i]!;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(q[i]!);
    else if (seg !== q[i]) return null;
  }
  return params;
};

/** 1 MB: this API takes JSON, never files. Capture is chat-only (§2). */
const MAX_BODY = 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('cuerpo demasiado grande');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const json = (res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // The API answers a browser on the same origin and nothing else. No CORS
    // header is set on purpose: a missing one is a closed door.
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
};

export function createRouter(routes: Route[], deps: Deps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    let route: Route | undefined;
    let params: Record<string, string> = {};
    let pathExists = false;

    for (const r of routes) {
      const m = match(r.path, url.pathname);
      if (!m) continue;
      pathExists = true;
      if (r.method === (req.method ?? 'GET')) { route = r; params = m; break; }
    }

    if (!route) {
      return json(res, pathExists ? 405 : 404, { error: { kind: 'not_found', message: 'No existe esa ruta.' } });
    }

    try {
      // The Actor comes from the session cookie and from nowhere else. There is
      // no route that reads an owner from a query parameter or a header, which
      // is what makes hard rule 9 structural here too (§15).
      const token = parseCookies(req.headers.cookie)[COOKIE];
      const session = await actorForToken(deps, token);

      if (!route.public && !session) {
        return json(res, 401, { error: { kind: 'forbidden', message: 'Sin sesión.' } });
      }

      let cached: string | null = null;
      const ctx: Ctx = {
        deps,
        actor: session?.actor ?? { ownerId: '' },
        req, url, params,
        body: async <T>(): Promise<T> => {
          cached ??= await readBody(req);
          return (cached ? JSON.parse(cached) : {}) as T;
        },
      };

      const out = await route.handler(ctx);

      if ('raw' in out) {
        res.writeHead(out.status ?? 200, out.headers);
        return void res.end(out.body);
      }
      if (out.ok) return json(res, 200, { data: out.value });

      return json(res, STATUS[out.kind] ?? 400, {
        error: {
          kind: out.kind,
          message: out.message,
          ...('affects' in out ? { affects: out.affects } : {}),
        },
      });
    } catch (e) {
      // The message is logged, not returned: an internal error is the one place
      // a stranger could learn about the inside of the system for free.
      console.error('[api]', e instanceof Error ? e.message : String(e));
      return json(res, 500, { error: { kind: 'invalid', message: 'Algo falló.' } });
    }
  };
}

export const setCookie = (token: string, expires: Date): string =>
  [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Expires=${expires.toUTCString()}`,
    // No `Secure`: this listens on 127.0.0.1 over plain HTTP, and a Secure
    // cookie would simply never be sent back. The port not existing from
    // outside is the defence here, not TLS (§15).
  ].join('; ');

export const clearCookie = (): string =>
  `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
