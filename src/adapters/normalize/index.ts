import type { Converters } from '../../core/ports.js';
import { claudeVisionConverter, type VisionConfig } from './claude-vision.js';
import { documentsConverter, rasterizePdf, transcodeImage, type DocumentsConfig } from './documents.js';
import { ocrConverter, type OcrConfig } from './ocr.js';
import { openAiVisionConverter, type VisionHttpConfig } from './vision-openai.js';
import { speechConverter, type SpeechConfig } from './whisper-http.js';

export * from './claude-vision.js';
export * from './documents.js';
export * from './http.js';
export * from './ocr.js';
export * from './prompt.js';
export * from './vision-openai.js';
export * from './whisper-http.js';

/**
 * Cuál motor atiende el carril de visión. Es una variable de entorno y no una
 * decisión de arquitectura: los tres caminos implementan el mismo `Converter`,
 * reciben el mismo prompt y devuelven lo mismo.
 */
export type VisionBackend = 'ocr' | 'anthropic' | 'openai' | 'none';

export const VISION_BACKENDS: readonly VisionBackend[] = ['ocr', 'anthropic', 'openai', 'none'];

export interface NormalizeConfig {
  documents: DocumentsConfig;
  vision: {
    backend: VisionBackend;
    ocr: OcrConfig;
    anthropic: VisionConfig;
    openai: VisionHttpConfig;
  };
  speech: SpeechConfig;
}

/**
 * Arma los tres carriles desde la config. Que un carril *funcione* no se decide
 * acá: lo dice `available()`, y a falta de eso lo dice el error que queda en la
 * fila. Un carril mal configurado no puede verse igual que uno apagado a
 * propósito, o una memoria se queda sin texto y nadie sabe por qué.
 *
 * La única ranura que puede ser `null` es visión con `backend: 'none'`, y ahí sí
 * es deliberado: es cómo se dice "por ahora no quiero transcribir imágenes".
 */
export function buildConverters(cfg: NormalizeConfig): Converters {
  const documents = documentsConverter(cfg.documents);

  // Ni el OCR ni el chat de OpenAI saben recibir un PDF, así que se lo pasan a
  // quien ya tiene pypdfium cargado. Anthropic es el único que no lo necesita
  // —recibe el PDF entero— y por eso ahí el rasterizador ni se inyecta.
  const rasterize = (bytes: Buffer) => rasterizePdf(cfg.documents, bytes);
  // Mismo sidecar, misma idea: el carril no sabe convertir y no tiene por qué.
  const transcode = (bytes: Buffer, filename: string | null) =>
    transcodeImage(cfg.documents, bytes, filename);

  const vision =
    cfg.vision.backend === 'ocr' ? ocrConverter(cfg.vision.ocr, rasterize, transcode)
    : cfg.vision.backend === 'anthropic' ? claudeVisionConverter(cfg.vision.anthropic)
    : cfg.vision.backend === 'openai' ? openAiVisionConverter(cfg.vision.openai, rasterize)
    : null;

  return { document: documents, vision, audio: speechConverter(cfg.speech) };
}
