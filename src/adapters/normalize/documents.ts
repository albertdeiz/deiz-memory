import { extensionForMediaType, extensionOf } from '../../core/media.js';
import type { Converter, ExtractInput } from '../../core/ports.js';
import { formWithFile, postJson, probe } from './http.js';

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
 * una URL. Eso es lo que hace que el mismo compose corra en tu Mac, en un VPS y
 * en una Raspberry Pi sin tocar nada.
 *
 * Sigue sin hacer OCR, que es la razón de que exista el carril B.
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
