import type { NextRequest } from 'next/server';

/**
 * The proxy to `dm api`, resolved per request.
 *
 * This started as a `rewrites()` entry in next.config and that was wrong in a
 * way the container proved: Next resolves rewrites at BUILD time and bakes the
 * destination into the routes manifest. The image came out pointing at
 * 127.0.0.1 — itself — and every call died with ECONNREFUSED. Reading the
 * variable here means the same image works against the compose network and
 * against a localhost in development, which is what §7 asks of every dependency.
 *
 * The point of proxying at all is one origin: the browser never talks to the API
 * directly, so the session cookie can be SameSite=Strict and no CORS header has
 * to exist anywhere.
 */

const API = (): string => process.env.DM_API_URL ?? 'http://127.0.0.1:4317';

// Never cached: this is somebody's records, and a proxy that caches them is a
// proxy that serves them to the next person.
export const dynamic = 'force-dynamic';

async function forward(req: NextRequest, path: string[]): Promise<Response> {
  const target = `${API()}/api/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: {
        // Only what the API actually reads. Forwarding the browser's headers
        // wholesale is how a host or an accept-encoding ends up meaning
        // something it should not.
        ...(req.headers.get('cookie') ? { cookie: req.headers.get('cookie')! } : {}),
        ...(req.headers.get('content-type') ? { 'content-type': req.headers.get('content-type')! } : {}),
        ...(req.headers.get('user-agent') ? { 'user-agent': req.headers.get('user-agent')! } : {}),
      },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text(),
      redirect: 'manual',
    });
  } catch {
    return Response.json(
      { error: { kind: 'offline', message: 'No hay respuesta de la API. ¿Está corriendo `dm api`?' } },
      { status: 503 },
    );
  }

  const headers = new Headers();
  for (const name of ['content-type', 'content-disposition', 'cache-control']) {
    const v = upstream.headers.get(name);
    if (v) headers.set(name, v);
  }
  // set-cookie is the whole login: without it the session never reaches the
  // browser. getSetCookie() and not get(), because there can be more than one.
  for (const c of upstream.headers.getSetCookie()) headers.append('set-cookie', c);

  // The body streams: a blob route hands back a PDF, and buffering it here
  // would load someone's documents into memory for no reason.
  return new Response(upstream.body, { status: upstream.status, headers });
}

type Params = { params: Promise<{ path: string[] }> };
const handler = async (req: NextRequest, { params }: Params): Promise<Response> =>
  forward(req, (await params).path);

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
