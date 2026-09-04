import type { Converter, ExtractInput } from '../../core/ports';
import { formWithFile, postJson, probe } from './http';
import { IMAGE_TYPES, unsupportedImage } from './prompt';
import type { Rasterizer, Transcoder } from './vision-openai';

export interface OcrConfig {
  baseUrl: string;
  timeoutMs: number;
}

export const defaultOcrConfig: OcrConfig = {
  baseUrl: 'http://localhost:8083',
  timeoutMs: 300_000,
};

interface OcrResponse {
  text: string;
  lines: { text: string; score: number | null }[];
  mean_confidence: number;
  low_confidence: boolean;
  engine: string;
}

/**
 * The visual lane via classical OCR: the local, free and deterministic path.
 *
 * For printed documents — receipts, policies, ID cards — this is *better* than a
 * modelo multimodal chico, no un premio de consuelo. Los VLM leen bien el texto
 * and fail on strings that cannot be guessed from context: a policy number, a
 * tax id, an amount. Which is exactly the datum you came looking for.
 *
 * It also keeps a promise the cloud cannot: it is reproducible. The same blob
 * gives the same text, today and in two years.
 *
 * **What this lane cannot do**, and why the model-backed one still exists:
 * handwriting, and describing a photo with no text. In a photo of a car crash
 * OCR finds nothing; a multimodal model at least says what is visible.
 */
export function ocrConverter(
  cfg: OcrConfig = defaultOcrConfig,
  rasterize?: Rasterizer,
  transcode?: Transcoder,
): Converter {
  const base = cfg.baseUrl.replace(/\/$/, '');

  const read = (bytes: Buffer, name: string, mediaType: string) =>
    postJson<OcrResponse>({
      service: 'ocr',
      url: `${base}/ocr`,
      body: formWithFile(bytes, name, mediaType),
      timeoutMs: cfg.timeoutMs,
    });

  return {
    async extract({ bytes, mediaType, filename }: ExtractInput) {
      if (mediaType === 'application/pdf') {
        if (!rasterize) {
          throw new Error(
            'el OCR no lee PDF directamente y no hay servicio de documentos para rasterizarlo. ' +
              'Levanta el sidecar de documentos.',
          );
        }
        const raster = await rasterize(bytes);
        if (raster.pages.length === 0) throw new Error('el PDF no tiene páginas que rasterizar');

        const results: OcrResponse[] = [];
        // Serial and not parallel: on a host that also runs the database and the object
        // store, firing N inferences at once makes the total slower.
        for (const page of raster.pages) {
          results.push(await read(Buffer.from(page.dataBase64, 'base64'), `p${page.index}.png`, page.mediaType));
        }

        const text = results
          .map((r, i) => (results.length > 1 ? `<!-- página ${i + 1} -->\n${r.text}` : r.text))
          .join('\n\n')
          .trim();

        const scores = results.map((r) => r.mean_confidence).filter((n) => n > 0);
        const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
        const dudoso = results.some((r) => r.low_confidence);

        return {
          text,
          ...(raster.truncated
            ? { incomplete: `solo se leyeron ${raster.pages.length} de ${raster.totalPages} páginas` }
            : dudoso
              ? { incomplete: `el OCR quedó con poca confianza (${mean.toFixed(2)}): conviene revisarlo` }
              : {}),
          detail: {
            tool: results[0]?.engine ?? 'ocr',
            pages: results.length,
            totalPages: raster.totalPages,
            meanConfidence: Number(mean.toFixed(4)),
          },
        };
      }

      let leible = { bytes, mediaType };
      if (!IMAGE_TYPES.includes(mediaType)) {
        // A HEIC lands here. Before giving up, conversion is attempted: the original
        // stays intact and only what is handed to the engine changes.
        if (!transcode) throw unsupportedImage(mediaType);
        const jpeg = await transcode(bytes, filename);
        leible = { bytes: jpeg.bytes, mediaType: jpeg.mediaType };
      }

      const res = await read(leible.bytes, filename ?? 'imagen', leible.mediaType);
      return {
        text: res.text,
        // The service saying "I read this with low confidence", recorded, is what turns
        // a doubtful transcript into something a reprocess can pick up, rather than a
        // datum that looks firm and is not.
        ...(res.low_confidence
          ? { incomplete: `el OCR quedó con poca confianza (${res.mean_confidence}): conviene revisarlo` }
          : {}),
        detail: { tool: res.engine, lines: res.lines.length, meanConfidence: res.mean_confidence },
      };
    },

    async available() {
      const state = await probe('ocr', `${base}/health`);
      return state.ok ? { ok: true, detail: `rapidocr @ ${base}` } : state;
    },
  };
}
