/**
 * La instrucción del carril B, en un solo lugar.
 *
 * Vive aparte de cualquier proveedor a propósito. El carril de visión ahora
 * puede salir por Anthropic, por OpenAI o por un modelo local, y si cada
 * adapter llevara su propia copia, la calidad de la transcripción dependería
 * en silencio de cuál te tocó. El proveedor es intercambiable; lo que se le
 * pide, no.
 *
 * markitdown sobre una imagen da una *descripción* ("una boleta de
 * supermercado"), y una descripción no sirve para encontrar nada: lo que se
 * busca es el monto, la fecha, el número de póliza. Por eso todo acá empuja
 * hacia transcripción literal, y en especial la regla de los dígitos — un
 * número de póliza inventado es exactamente el modo de falla que este sistema
 * existe para evitar (regla dura 2, "nunca inventar").
 */
export const TRANSCRIPTION_PROMPT = `Transcribe fielmente el contenido de este documento.

- Devuelve el texto tal como aparece. No resumas, no interpretes, no completes lo que falte.
- Conserva la estructura en Markdown: títulos, listas y sobre todo tablas.
- Montos, fechas, RUT, patentes, números de póliza y teléfonos van exactos, dígito por dígito.
- Lo que no se lea con seguridad va marcado como [ilegible]. Nunca lo adivines.
- No agregues comentarios, encabezados ni "Aquí está la transcripción". Solo el contenido.
- Si no hay texto, describe en una sola línea qué se ve.`;

import { PermanentError } from '../../core/result.js';

/** Los únicos formatos que aceptan tanto la API de Anthropic como las compatibles con OpenAI. */
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export const unsupportedImage = (mediaType: string): Error =>
  // Permanente: el mismo archivo por el mismo carril va a fallar igual mañana.
  // Se arregla convirtiendo el archivo o enseñándole el formato al carril, no
  // reintentando.
  new PermanentError(
    `la API no acepta ${mediaType} como imagen (solo ${IMAGE_TYPES.join(', ')} y PDF). ` +
      'Conviértelo antes de guardarlo, o vuelve a mandarlo como JPEG.',
  );
