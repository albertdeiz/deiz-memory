/**
 * El router de carriles de §8.1. Es lógica pura a propósito: la decisión de qué
 * herramienta usar es una regla del producto, no un detalle de los adapters, y
 * tiene que poder probarse sin Docker, sin red y sin gastar un peso en tokens.
 *
 * La advertencia que define todo esto: **markitdown no hace OCR**. Un PDF
 * escaneado devuelve vacío y una foto devuelve, como mucho, una descripción.
 * Por eso no hay "una llamada de normalización": hay carriles y una regla de
 * caída entre ellos.
 */
import type { Lane } from '../domain/types.js';

export type { Lane };

export const LANES: readonly Lane[] = ['text', 'document', 'vision', 'audio', 'none'];

/**
 * §8.1: "PDF escaneado (capa de texto < ~100 chars)". Debajo de esto asumimos
 * que no había capa de texto y que lo que corresponde es mirar el papel.
 */
export const POOR_TEXT_CHARS = 100;

/**
 * to_tsvector revienta pasado ~1MB. Un PDF de 600 páginas llega ahí sin
 * despeinarse, así que el texto se recorta antes de guardarlo y el recorte
 * queda anotado — el original sigue intacto y siempre se puede reprocesar.
 */
export const MAX_NORMALIZED_CHARS = 500_000;

const OOXML = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];

/**
 * Los carriles a intentar, en orden. El primero es el preferido; los siguientes
 * son la red debajo, y se usan por dos motivos distintos:
 *
 *   - el carril preferido no está configurado (sin uv, sin API key)
 *   - el carril preferido corrió y devolvió basura (el PDF escaneado)
 *
 * Un array vacío no es un error: es un formato del que honestamente no hay nada
 * que extraer. El blob se guarda igual.
 */
export function lanesFor(mediaType: string | null): Lane[] {
  if (!mediaType) return [];

  // Ya es texto: leerlo es la conversión. Barato, determinista, sin dependencias.
  if (mediaType === 'text/plain' || mediaType === 'text/markdown') return ['text'];

  // markitdown preserva la estructura (una tabla sigue pareciendo una tabla),
  // que es mejor insumo que aplanarlo. Pero si no está, esto igual es texto:
  // leerlo crudo es peor y sirve.
  if (mediaType === 'text/html' || mediaType === 'text/csv' || mediaType === 'application/json') {
    return ['document', 'text'];
  }

  // El caso que justifica toda la máquina: sale por A si tiene capa de texto,
  // y por B si es un escaneo.
  if (mediaType === 'application/pdf') return ['document', 'vision'];

  if (OOXML.includes(mediaType)) return ['document'];

  // markitdown sobre una imagen da una *descripción*, y una descripción no es
  // una transcripción: para una receta manuscrita no sirve de nada.
  if (mediaType.startsWith('image/')) return ['vision'];

  if (mediaType.startsWith('audio/')) return ['audio'];

  // Video: se guarda, no se transcribe. Extraer la pista de audio es trabajo de
  // otra fase y fingir lo contrario sería peor que decirlo.
  return [];
}

/** Poco texto y sin estructura: lo que devuelve un PDF sin capa de texto. */
export const isPoor = (text: string | null | undefined): boolean =>
  (text ?? '').trim().length < POOR_TEXT_CHARS;

/**
 * Normaliza a NFKC antes de guardar.
 *
 * No es cosmético. Un motor de OCR puede devolver caracteres de ancho completo
 * —`INMOBＩLＩＡRＩＡ` con U+FF29 en vez de `I`— y el `unaccent` de Postgres no los
 * toca, así que ese documento deja de aparecer al buscar "inmobiliaria". Pasó
 * de verdad, con un plano de edificio escaneado.
 *
 * NFKC también arregla ligaduras (`ﬁ` → `fi`) y superíndices, que fallan igual.
 * Se aplica a todo lo derivado y a ningún original: el blob no se toca, y este
 * texto se regenera cuando haga falta.
 */
export const canonical = (text: string): string => text.normalize('NFKC');

/** Recorta al límite del tsvector, avisando en el propio texto que se recortó. */
export function clamp(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_NORMALIZED_CHARS) return { text, truncated: false };
  return {
    text: text.slice(0, MAX_NORMALIZED_CHARS) + '\n\n[texto recortado para indexar; el original está completo]',
    truncated: true,
  };
}
