/**
 * The little the lanes share now that all of them go out over HTTP to a service
 * next door. The runtime brings fetch, FormData and Blob natively, so this adds
 * not one dependency.
 */

export class ServiceError extends Error {
  constructor(readonly service: string, message: string, readonly status?: number) {
    super(message);
    this.name = 'ServiceError';
  }
}

const describe = (service: string, url: string, e: unknown): ServiceError => {
  const raw = e instanceof Error ? e.message : String(e);
  // A raw connection-refused tells nobody anything at eleven at night.
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return new ServiceError(service, `${service} no respondió a tiempo (${url})`);
  }
  if (raw.includes('ECONNREFUSED') || raw.includes('fetch failed')) {
    return new ServiceError(service, `no pude conectarme a ${service} en ${url} — ¿está levantado?`);
  }
  return new ServiceError(service, `${service}: ${raw}`);
};

export interface PostOpts {
  service: string;
  url: string;
  body: FormData | string;
  headers?: Record<string, string>;
  timeoutMs: number;
}

export async function postJson<T>(opts: PostOpts): Promise<T> {
  let res: Response;
  try {
    res = await fetch(opts.url, {
      method: 'POST',
      body: opts.body,
      headers: opts.headers ?? {},
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    throw describe(opts.service, opts.url, e);
  }

  if (!res.ok) {
    // The error body almost always carries the real reason; it is clipped
    // porque a veces viene un stacktrace entero.
    const detail = await res.text().catch(() => '');
    throw new ServiceError(
      opts.service,
      `${opts.service} respondió ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      res.status,
    );
  }

  try {
    return (await res.json()) as T;
  } catch (e) {
    throw new ServiceError(opts.service, `${opts.service} devolvió algo que no es JSON`);
  }
}

/** A short GET for the health check: is the service alive? */
export async function probe(
  service: string,
  url: string,
  timeoutMs = 5_000,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
    if (res.ok) return { ok: true, detail: url };
    // A 401 is not "the service is down": it is alive and rejecting us. Saying the
    // latter sends you to check the credential; saying the former sends you to check
    // docker, que es media hora perdida en el lugar equivocado.
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: `${service} responde pero rechaza la credencial (revisa su API key)` };
    }
    return { ok: false, detail: `${url} respondió ${res.status}` };
  } catch (e) {
    return { ok: false, detail: describe(service, url, e).message };
  }
}

export const formWithFile = (
  bytes: Buffer,
  filename: string,
  mediaType: string,
  extra: Record<string, string> = {},
): FormData => {
  const form = new FormData();
  // Uint8Array y no Buffer: Blob no acepta el Buffer de Node en todos los
  // runtimes. The name matters — the converter is chosen by extension.
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mediaType }), filename);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
};
