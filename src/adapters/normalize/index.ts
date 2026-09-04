import type { Converters } from '../../core/ports';
import { claudeVisionConverter, type VisionConfig } from './claude-vision';
import { documentsConverter, rasterizePdf, transcodeImage, type DocumentsConfig } from './documents';
import { ocrConverter, type OcrConfig } from './ocr';
import { openAiVisionConverter, type VisionHttpConfig } from './vision-openai';
import { speechConverter, type SpeechConfig } from './whisper-http';

export * from './claude-vision';
export * from './documents';
export * from './http';
export * from './ocr';
export * from './prompt';
export * from './vision-openai';
export * from './whisper-http';

/**
 * Which engine serves the visual lane. An environment variable and not an
 * architectural decision: all three paths implement the same converter port,
 * take the same prompt and return the same thing.
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
 * Builds the three lanes from config. Whether a lane *works* is not decided
 * here: the availability probe says that, and failing that the error left on the
 * row does. A misconfigured lane must not look the same as one deliberately off,
 * or a memory ends up with no text and nobody knows why.
 *
 * The only slot that may be null is the visual one with its backend set to none,
 * and there it is deliberate: it is how you say "I do not want image transcription".
 */
export function buildConverters(cfg: NormalizeConfig): Converters {
  const documents = documentsConverter(cfg.documents);

  // Neither OCR nor a chat-style API can take a PDF, so they hand it to whoever
  // already has the PDF library loaded. One provider does not need it — it takes
  // the whole PDF — so there the rasterizer is not even injected.
  const rasterize = (bytes: Buffer) => rasterizePdf(cfg.documents, bytes);
  // Same service, same idea: the lane cannot convert and has no business doing so.
  const transcode = (bytes: Buffer, filename: string | null) =>
    transcodeImage(cfg.documents, bytes, filename);

  const vision =
    cfg.vision.backend === 'ocr' ? ocrConverter(cfg.vision.ocr, rasterize, transcode)
    : cfg.vision.backend === 'anthropic' ? claudeVisionConverter(cfg.vision.anthropic)
    : cfg.vision.backend === 'openai' ? openAiVisionConverter(cfg.vision.openai, rasterize)
    : null;

  return { document: documents, vision, audio: speechConverter(cfg.speech) };
}
