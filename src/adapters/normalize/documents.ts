import { extensionForMediaType, extensionOf } from '../../core/media';
import type { Converter, ExtractInput } from '../../core/ports';
import { formWithFile, postJson, probe } from './http';

export interface DocumentsConfig {
  baseUrl: string;
  timeoutMs: number;
}

export const defaultDocumentsConfig: DocumentsConfig = {
  baseUrl: 'http://localhost:8081',
  timeoutMs: 120_000,
};

interface ConvertResponse {
  text: string;
  title: string | null;
  tool: string;
  extension: string | null;
}

export interface RasterPage {
  index: number;
  mediaType: string;
  dataBase64: string;
}

export interface RasterResult {
  pages: RasterPage[];
  totalPages: number;
  truncated: boolean;
}

const nameFor = (input: ExtractInput): string => {
  const ext = extensionOf(input.filename) || extensionForMediaType(input.mediaType);
  return input.filename ?? `blob.${ext}`;
};

/**
 * Carril A (§8.1), ahora contra el sidecar de documentos en vez de `uvx`.
 *
 * El cambio no es de herramienta —sigue siendo markitdown— sino de frontera:
 * antes el core necesitaba Python y uv instalados en el host, y ahora necesita
 * a URL. That is what lets the same compose run on a laptop, on a VPS and on a
 * small board without touching anything.
 *
 * It still does no OCR, which is the reason the visual lane exists.
 */
export function documentsConverter(cfg: DocumentsConfig = defaultDocumentsConfig): Converter {
  return {
    async extract(input: ExtractInput) {
      const res = await postJson<ConvertResponse>({
        service: 'documentos',
        url: `${cfg.baseUrl}/convert`,
        body: formWithFile(input.bytes, nameFor(input), input.mediaType),
        timeoutMs: cfg.timeoutMs,
      });
      return {
        text: res.text ?? '',
        detail: { tool: res.tool, extension: res.extension, ...(res.title ? { title: res.title } : {}) },
      };
    },

    async available() {
      return probe('documentos', `${cfg.baseUrl}/health`);
    },
  };
}

export interface Transcoded {
  mediaType: string;
  bytes: Buffer;
}

/**
 * An image no lane can read, turned into JPEG.
 *
 * It exists because of HEIC: the default for iPhone photos, which neither the
 * acepta ni el OCR ni la API de visión. Sin esto, mandar una foto desde el
 * teléfono la guarda muda.
 *
 * El original no se toca (§3.6). Esto produce bytes nuevos solo para leer; el
 * blob sigue siendo el HEIC, así que el día que algo lo lea nativo se reprocesa
 * y se gana calidad sin haber perdido nada.
 */
export async function transcodeImage(
  cfg: DocumentsConfig,
  bytes: Buffer,
  filename: string | null,
): Promise<Transcoded> {
  const res = await postJson<{ media_type: string; data_base64: string }>({
    service: 'documentos',
    url: `${cfg.baseUrl}/transcode`,
    body: formWithFile(bytes, filename ?? 'imagen', 'application/octet-stream'),
    timeoutMs: cfg.timeoutMs,
  });
  return { mediaType: res.media_type, bytes: Buffer.from(res.data_base64, 'base64') };
}

/**
 * Páginas de PDF a PNG.
 *
 * Vive acá y no en el carril de visión porque el sidecar ya tiene pypdfium
 * cargado, y porque quién sabe rasterizar no debería depender de a qué modelo
 * le vayas a mandar las imágenes después.
 */
export async function rasterizePdf(
  cfg: DocumentsConfig,
  bytes: Buffer,
  opts: { dpi?: number; maxPages?: number } = {},
): Promise<RasterResult> {
  const extra: Record<string, string> = {};
  if (opts.dpi) extra.dpi = String(opts.dpi);
  if (opts.maxPages) extra.max_pages = String(opts.maxPages);

  const res = await postJson<{
    pages: { index: number; media_type: string; data_base64: string }[];
    total_pages: number;
    truncated: boolean;
  }>({
    service: 'documentos',
    url: `${cfg.baseUrl}/rasterize`,
    body: formWithFile(bytes, 'documento.pdf', 'application/pdf', extra),
    timeoutMs: cfg.timeoutMs,
  });

  return {
    pages: res.pages.map((p) => ({ index: p.index, mediaType: p.media_type, dataBase64: p.data_base64 })),
    totalPages: res.total_pages,
    truncated: res.truncated,
  };
}
