import type { Converter, ExtractInput } from '../../core/ports.js';
import { formWithFile, postJson, probe } from './http.js';
import { IMAGE_TYPES, unsupportedImage } from './prompt.js';
import type { Rasterizer, Transcoder } from './vision-openai.js';

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
 * Carril B por OCR clásico: el camino local, gratis y determinista.
 *
 * Para documentos impresos —boletas, pólizas, carnets— esto es *mejor* que un
 * modelo multimodal chico, no un premio de consuelo. Los VLM leen bien el texto
 * corrido y fallan en cadenas que no se pueden adivinar por contexto: un número
 * de póliza, un RUT, un monto. Y ese es justo el dato que uno viene a buscar.
 *
 * Además cumple una promesa que la nube no puede: es reproducible. El mismo
 * blob da el mismo texto, hoy y en dos años (§3.6).
 *
 * **Lo que este carril no puede hacer**, y por lo que el de visión sigue
 * existiendo: manuscrito, y describir una foto sin texto. A la foto de un choque
 * el OCR no le encuentra nada; un modelo multimodal al menos dice qué se ve.
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
        // En serie y no en paralelo: en un host que además corre Postgres y
        // Garage, lanzar N inferencias a la vez hace más lento el total.
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
        // Un HEIC llega acá. Antes de darlo por perdido se intenta convertir:
        // el original queda intacto y solo cambia lo que se le pasa al motor.
        if (!transcode) throw unsupportedImage(mediaType);
        const jpeg = await transcode(bytes, filename);
        leible = { bytes: jpeg.bytes, mediaType: jpeg.mediaType };
      }

      const res = await read(leible.bytes, filename ?? 'imagen', leible.mediaType);
      return {
        text: res.text,
        // Que el servicio diga "leí con poca confianza" y quede marcado es lo
        // que convierte una transcripción dudosa en algo que dm reprocess puede
        // retomar, en vez de un dato que parece firme y no lo es.
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
