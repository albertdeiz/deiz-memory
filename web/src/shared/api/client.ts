/**
 * The one place that speaks HTTP.
 *
 * Everything above this file deals in data and in `ApiError`; nothing else
 * imports `fetch`. That is the same bargain the core makes with its ports, and
 * it buys the same thing — the day the transport changes, one file changes.
 */

export type ErrorKind =
  | 'invalid' | 'forbidden' | 'not_found' | 'conflict' | 'ambiguous'
  | 'requires_confirmation' | 'unauthenticated' | 'offline';

export interface Affected {
  kind: string;
  id: string;
  label?: string;
}

/**
 * A failure with the shape the core gave it.
 *
 * `requires_confirmation` is the one that matters and it is NOT an error: it is
 * the server saying "ask, then call me again", carrying what would be affected
 * by name. The UI turns it into a dialog; the CLI turns the same thing into
 * `--yes`. Flattening it into a generic failure here would lose the only
 * information that makes the dialog honest (§13.8).
 */
export class ApiError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly affects: Affected[] = [],
    readonly status = 0,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get needsConfirmation(): boolean {
    return this.kind === 'requires_confirmation';
  }
}

interface Envelope<T> {
  data?: T;
  error?: { kind: ErrorKind; message: string; affects?: Affected[] };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      // The session is a cookie the page cannot read, so it has to ride along
      // explicitly. Same origin, thanks to the proxy in next.config.
      credentials: 'same-origin',
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    // A dead API and a denied request are different problems with different
    // fixes, and telling them apart is the difference between "log in" and
    // "start dm api".
    throw new ApiError('offline', 'No hay respuesta de la API. ¿Está corriendo `dm api`?');
  }

  if (res.status === 401) {
    throw new ApiError('unauthenticated', 'Sesión terminada.', [], 401);
  }

  const text = await res.text();
  const body = (text ? JSON.parse(text) : {}) as Envelope<T>;

  if (!res.ok) {
    const e = body.error;
    throw new ApiError(e?.kind ?? 'invalid', e?.message ?? 'Algo falló.', e?.affects ?? [], res.status);
  }
  return body.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
