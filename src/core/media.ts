/**
 * Detección de media type por magic bytes, con la extensión como respaldo.
 * Los bytes mandan sobre el nombre: una foto renombrada a .pdf sigue siendo una foto.
 */
const BY_EXT: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  html: 'text/html', pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav',
  m4a: 'audio/mp4', mp4: 'video/mp4',
};

const OOXML: Record<string, string> = {
  docx: BY_EXT.docx!, xlsx: BY_EXT.xlsx!, pptx: BY_EXT.pptx!,
};

export const extensionOf = (filename?: string | null): string => {
  if (!filename) return '';
  const i = filename.lastIndexOf('.');
  return i < 0 ? '' : filename.slice(i + 1).toLowerCase();
};

const starts = (b: Buffer, sig: number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

const ascii = (b: Buffer, s: string, at = 0): boolean =>
  b.length >= at + s.length && b.subarray(at, at + s.length).toString('latin1') === s;

/** Heurística de texto: UTF-8 válido y sin bytes de control raros. */
export const looksLikeText = (b: Buffer): boolean => {
  const head = b.subarray(0, 4096);
  if (head.includes(0)) return false;
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(head);
  if (decoded.includes('�')) return false;
  let control = 0;
  for (const ch of decoded) {
    const c = ch.codePointAt(0)!;
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) control++;
  }
  return control / Math.max(decoded.length, 1) < 0.02;
};

export function detectMediaType(bytes: Buffer, filename?: string | null): string {
  const ext = extensionOf(filename);

  if (ascii(bytes, '%PDF-')) return 'application/pdf';
  if (starts(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(bytes, 'GIF87a') || ascii(bytes, 'GIF89a')) return 'image/gif';
  if (ascii(bytes, 'RIFF') && ascii(bytes, 'WEBP', 8)) return 'image/webp';
  if (ascii(bytes, 'RIFF') && ascii(bytes, 'WAVE', 8)) return 'audio/wav';
  if (ascii(bytes, 'OggS')) return 'audio/ogg';
  if (ascii(bytes, 'ID3') || starts(bytes, [0xff, 0xfb]) || starts(bytes, [0xff, 0xf3])) return 'audio/mpeg';
  if (ascii(bytes, 'ftyp', 4)) {
    const brand = bytes.subarray(8, 12).toString('latin1');
    if (brand.startsWith('M4A')) return 'audio/mp4';
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'image/heic';
    return 'video/mp4';
  }
  // Los formatos de Office son zip por dentro: sin nombre no se distinguen.
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04])) return OOXML[ext] ?? 'application/zip';

  if (ext && BY_EXT[ext]) return BY_EXT[ext]!;
  if (looksLikeText(bytes)) return 'text/plain';
  return 'application/octet-stream';
}
