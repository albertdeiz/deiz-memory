/**
 * Lo poco que comparten los carriles ahora que todos salen por HTTP a un
 * servicio de al lado. Node 22 trae fetch, FormData y Blob nativos, así que
 * esto no agrega una sola dependencia.
 */

export class ServiceError extends Error {
  constructor(readonly service: string, message: string, readonly status?: number) {
    super(message);
    this.name = 'ServiceError';
  }
}

const describe = (service: string, url: string, e: unknown): ServiceError => {
  const raw = e instanceof Error ? e.message : String(e);
  // Un ECONNREFUSED crudo no le dice nada a nadie a las once de la noche.
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
    // El cuerpo del error casi siempre trae el motivo de verdad; se recorta
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

/** Un GET corto para `dm doctor`: ¿está vivo el servicio? */
export async function probe(
  service: string,
  url: string,
  timeoutMs = 5_000,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
    if (res.ok) return { ok: true, detail: url };
    // Un 401 no es "el servicio está caído": está vivo y nos rechaza. Decir lo
    // segundo manda a revisar la credencial; decir lo primero manda a revisar
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
  // runtimes. El nombre importa — markitdown elige el conversor por extensión.
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mediaType }), filename);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
};
