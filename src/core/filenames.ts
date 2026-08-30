/**
 * La mayoría de los nombres de archivo no dicen nada: los pone la cámara, el
 * escáner o WhatsApp. Mostrar "IMG_20260114_093312.jpg" como si fuera el título
 * de una memoria es peor que no mostrar nada.
 *
 * Esto no adivina de qué se trata el archivo — eso es trabajo del clasificador
 * en F2. Solo decide si el nombre carga información o es ruido.
 */
const NOISE = [
  /^img\b/i, /^dsc\b/i, /^dscn\b/i, /^pxl\b/i, /^gopr\b/i,
  /^photo\b/i, /^foto\b/i, /^picture\b/i,
  /^screenshot/i, /^captura de pantalla/i, /^screen shot/i,
  /^whatsapp (image|video|audio|ptt|document)/i,
  /^scan\b/i, /^scanned/i, /^escaneo\b/i, /^cam\b/i,
  /^(doc|document|documento|file|archivo|image|imagen|video|audio)\s*\(?\d*\)?$/i,
  /^(download|descarga|untitled|sin titulo|nuevo documento|new document|copy|copia)\b/i,
  /^\d[\d\s]*$/,          // marcas de tiempo y epochs: 20260114 093312
  /^[0-9a-f]{8,}$/i,      // hashes y uuid
  /^[^a-záéíóúñü]*$/i,    // ni una sola letra
];

const PREFIXES = /^(copia de|copy of|duplicado de)\s+/i;

const stripExtension = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
};

/**
 * Devuelve el nombre si carga información, o null si es ruido de cámara/escáner.
 * Se limpia primero: "Copia de poliza.pdf" sí significa algo.
 */
export function meaningfulName(filename: string | null | undefined): string | null {
  if (!filename) return null;

  let base = stripExtension(filename.trim());
  while (PREFIXES.test(base)) base = base.replace(PREFIXES, '').trim();
  base = base
    .replace(/[._-]+/g, ' ')
    // "scan0001" y "IMG20260114" son una palabra pegada a un número: separarlos
    // es lo que permite reconocerlos con un patrón simple.
    .replace(/([a-záéíóúñü])(\d)/gi, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();

  if (base.length < 3) return null;
  if (NOISE.some((re) => re.test(base))) return null;

  // Debe quedar al menos una palabra de 3+ letras que no sea solo dígitos.
  const words = base.split(' ').filter((w) => /[a-záéíóúñü]{3,}/i.test(w));
  if (words.length === 0) return null;

  return base;
}
