/**
 * The visual lane's instruction, in one place.
 *
 * It sits apart from any provider on purpose. The visual lane can now go out
 * through several providers, and if each adapter carried its own copy the
 * quality of the transcript would silently depend on which one you got. The
 * provider is interchangeable; what it is asked for is not.
 * pide, no.
 *
 * A document converter on an image yields a *description* ("a supermarket
 * receipt"), and a description finds nothing: what you look for is the amount,
 * the date, the policy number. So everything here pushes toward literal
 * transcription, and especially the rule about digits — an invented policy
 * number is exactly the failure mode this system exists to prevent.
 * existe para evitar (regla dura 2, "nunca inventar").
 */
export const TRANSCRIPTION_PROMPT = `Transcribe fielmente el contenido de este documento.

- Devuelve el texto tal como aparece. No resumas, no interpretes, no completes lo que falte.
- Conserva la estructura en Markdown: títulos, listas y sobre todo tablas.
- Montos, fechas, RUT, patentes, números de póliza y teléfonos van exactos, dígito por dígito.
- Lo que no se lea con seguridad va marcado como [ilegible]. Nunca lo adivines.
- No agregues comentarios, encabezados ni "Aquí está la transcripción". Solo el contenido.
- Si no hay texto, describe en una sola línea qué se ve.`;

import { PermanentError } from '../../core/result';

/** The only formats every supported provider accepts. */
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export const unsupportedImage = (mediaType: string): Error =>
  // Permanent: the same file through the same lane will fail the same tomorrow.
  // It is fixed by converting the file or teaching the lane the format, not by
  // reintentando.
  new PermanentError(
    `la API no acepta ${mediaType} como imagen (solo ${IMAGE_TYPES.join(', ')} y PDF). ` +
      'Conviértelo antes de guardarlo, o vuelve a mandarlo como JPEG.',
  );
