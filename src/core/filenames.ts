/**
 * Most filenames say nothing: the camera, the scanner or the messaging app put
 * them there. Showing "IMG_20260114_093312.jpg" as a memory's title is worse
 * than showing nothing.
 *
 * This does not guess what a file is about — that is the classifier's job. It
 * only decides whether the name carries information or is noise.
 */
const NOISE = [
  /^img\b/i, /^dsc\b/i, /^dscn\b/i, /^pxl\b/i, /^gopr\b/i,
  /^photo\b/i, /^foto\b/i, /^picture\b/i,
  /^screenshot/i, /^captura de pantalla/i, /^screen shot/i,
  /^whatsapp (image|video|audio|ptt|document)/i,
  /^scan\b/i, /^scanned/i, /^escaneo\b/i, /^cam\b/i,
  /^(doc|document|documento|file|archivo|image|imagen|video|audio)\s*\(?\d*\)?$/i,
  /^(download|descarga|untitled|sin titulo|nuevo documento|new document|copy|copia)\b/i,
  /^\d[\d\s]*$/,          // timestamps and epochs: 20260114 093312
  /^[0-9a-f]{8,}$/i,      // hashes and uuids
  /^[^a-záéíóúñü]*$/i,    // not a single letter
];

const PREFIXES = /^(copia de|copy of|duplicado de)\s+/i;

const stripExtension = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
};

/**
 * Returns the name when it carries information, or null when it is camera or
 * scanner noise. Cleaned first, because "Copia de poliza.pdf" does mean
 * something once the prefix is gone.
 */
export function meaningfulName(filename: string | null | undefined): string | null {
  if (!filename) return null;

  let base = stripExtension(filename.trim());
  while (PREFIXES.test(base)) base = base.replace(PREFIXES, '').trim();
  base = base
    .replace(/[._-]+/g, ' ')
    // "scan0001" and "IMG20260114" are a word glued to a number; splitting them
    // is what lets a simple pattern recognise them.
    .replace(/([a-záéíóúñü])(\d)/gi, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();

  if (base.length < 3) return null;
  if (NOISE.some((re) => re.test(base))) return null;

  // At least one word of 3+ letters has to survive, not just digits.
  const words = base.split(' ').filter((w) => /[a-záéíóúñü]{3,}/i.test(w));
  if (words.length === 0) return null;

  return base;
}
