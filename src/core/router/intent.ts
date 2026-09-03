import type { Attachment, Incoming } from '../channel/types.js';
import { parseAction, type Action } from './actions.js';

/**
 * Los tres verbos de §5, decididos con lógica pura.
 *
 * Vive en el core y no en el adapter por el mismo motivo que `lanes.ts`: qué
 * hace el sistema cuando le mandas algo es una regla del producto, no un
 * detalle de Telegram. Y siendo pura se prueba entera sin base, sin red y sin
 * un token de bot.
 */
export type Intent =
  | { verb: 'capturar'; text: string | null; attachment: Attachment | null }
  | { verb: 'recordar'; query: string; adivinado: boolean }
  | { verb: 'accion'; action: Action }
  | { verb: 'parear'; code: string }
  | { verb: 'pendientes' }
  | { verb: 'revisar' }
  | { verb: 'dominios' }
  | { verb: 'proponer' }
  | { verb: 'crearDominio'; label: string; description: string }
  | { verb: 'describirDominio'; ref: string; description: string }
  | { verb: 'renombrarDominio'; ref: string; label: string }
  | { verb: 'archivarDominio'; ref: string }
  | { verb: 'fusionarDominios'; from: string; into: string }
  | { verb: 'enDominio'; ref: string }
  | { verb: 'ayuda' };
// 'aclarar' (§5) todavía no existe: no hay clasificador que dude. Llega en F2.

const normalize = (s: string): string =>
  s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Palabras que no aportan nada a un tsquery y sí ensucian el ranking. */
const STOP = new Set([
  'cual', 'cuales', 'que', 'cuando', 'donde', 'cuanto', 'cuanta', 'quien', 'como',
  'tengo', 'tienes', 'busca', 'buscar', 'encuentra', 'encontrar', 'muestra',
  'mostrar', 'dame', 'hay', 'es', 'el', 'la', 'los', 'las', 'de', 'del', 'mi',
  'mis', 'un', 'una', 'y', 'o', 'a', 'en', 'para', 'por',
]);

/** Deja solo las palabras con contenido. Si no queda ninguna, no hay búsqueda. */
export function contentWords(text: string): string {
  return normalize(text)
    .replace(/[¿?¡!.,;:]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .join(' ')
    .trim();
}

export interface Session {
  /** Ids de la última página mostrada, para que "ver 3" signifique algo. */
  ids: string[];
  hasConfirm: boolean;
  /**
   * Hay un texto esperando que digas "guardar".
   *
   * Cuenta como algo en pantalla igual que una lista. Sin esto, escribir
   * `save` —en vez de pulsar el botón— no era una acción, se iba por texto
   * libre y el ofrecimiento se perdía. Con el texto libre convertido en
   * consulta, esa escotilla es lo único que sostiene "no se pierde nada".
   */
  hasSave: boolean;
}

/**
 * De lo más explícito a lo más ambiguo. El orden es la regla: un comando gana
 * siempre, y solo al final se decide sobre texto libre.
 */
export function classify(msg: Incoming, session: Session | null): Intent {
  const pending =
    (session?.ids.length ?? 0) > 0 || session?.hasConfirm === true || session?.hasSave === true;

  // 1 · un botón ya presionado no se interpreta, se obedece
  if (msg.action) {
    const a = parseAction(msg.action, true);
    if (a) return { verb: 'accion', action: a };
  }

  const text = msg.text?.trim() ?? '';

  // 2 · comandos explícitos
  if (text.startsWith('/')) {
    const [rawCmd, ...rest] = text.slice(1).split(/\s+/);
    const cmd = normalize(rawCmd ?? '');
    const arg = rest.join(' ').trim();

    // Los comandos son los del CLI: `/search` es `dm search`, `/capture` es
    // `dm capture`. Uno solo por operación — dos nombres para lo mismo es uno
    // que hay que mantener sincronizado con el otro para siempre.
    if (cmd === 'start') return { verb: 'parear', code: arg };
    if (cmd === 'help') return { verb: 'ayuda' };

    // Guardar es explícito: es la única forma de que un texto suelto entre al
    // corpus. Ver la nota de `classify()` más abajo.
    if (cmd === 'capture') return { verb: 'capturar', text: arg || null, attachment: null };

    // `/search` lista; `/ask` responde citando. La diferencia es la de §6, y
    // vale tenerla a mano: a veces quieres el dato y a veces los documentos.
    if (cmd === 'search') return { verb: 'recordar', query: arg, adivinado: false };
    if (cmd === 'ask') return { verb: 'recordar', query: contentWords(arg) || arg, adivinado: true };

    if (cmd === 'pending') return { verb: 'pendientes' };
    if (cmd === 'review') return { verb: 'revisar' };
    if (cmd === 'more') return { verb: 'accion', action: { kind: 'mas' } };
    if (cmd === 'domains') return { verb: 'dominios' };
    if (cmd === 'propose') return { verb: 'proponer' };

    // CRUD de categorías desde el chat, que es donde §9 lo quiere.
    //
    // El separador es `:` y no un segundo argumento posicional porque tanto el
    // nombre como la descripción llevan espacios, y pedirle comillas a alguien
    // que escribe desde el teléfono es pedirle que no lo use.
    if (cmd === 'create') {
      const [nombre, ...resto] = arg.split(':');
      return { verb: 'crearDominio', label: (nombre ?? '').trim(), description: resto.join(':').trim() };
    }
    if (cmd === 'describe') {
      const [ref, ...resto] = arg.split(':');
      return { verb: 'describirDominio', ref: (ref ?? '').trim(), description: resto.join(':').trim() };
    }
    if (cmd === 'rename') {
      const [ref, ...resto] = arg.split(/\s+/);
      return { verb: 'renombrarDominio', ref: ref ?? '', label: resto.join(' ').trim() };
    }
    if (cmd === 'archive') return { verb: 'archivarDominio', ref: arg };
    if (cmd === 'merge') {
      const [from, into] = arg.split(/\s+/);
      return { verb: 'fusionarDominios', from: from ?? '', into: into ?? '' };
    }
    // Cualquier otro /slug es "muéstrame lo de esa categoría" (§9). Se resuelve
    // contra la tabla, no contra una lista en el código — que es el punto
    // entero de que los dominios sean data.
    if (/^[a-z0-9-]{2,32}$/.test(cmd)) return { verb: 'enDominio', ref: cmd };
    return { verb: 'ayuda' };
  }

  // 3 · una palabra de acción, pero solo si hay algo en pantalla esperándola.
  //     Es la rama que hace real la degradación sin botones.
  if (!msg.attachment && text) {
    // Solo con algo en pantalla: sin lista, "más" o "2" son texto que guardar.
    const a = parseAction(text, pending);
    if (a && pending) return { verb: 'accion', action: a };
  }

  // 4 · hay archivo: se guarda, y el texto va de nota
  if (msg.attachment) {
    return { verb: 'capturar', text: text || null, attachment: msg.attachment };
  }

  // 5 · texto libre: se consulta, no se guarda.
  //
  // **Esto invierte §5 para el chat, a propósito y por experiencia de uso.** §5
  // dice que la ambigüedad se resuelve a favor de capturar, y para el correo o
  // un botón de compartir eso es correcto. En una conversación no: lo que
  // escribes en un chat es, casi siempre, algo que le estás preguntando a
  // alguien. Adivinar con una heurística —"¿empieza con cuál?"— acertaba a
  // medias y dejaba preguntas guardadas como memorias, que después hay que
  // ocultar a mano.
  //
  // Guardar pasa a ser explícito: un archivo, o `/capture`. Y el espíritu de §5
  // se sostiene donde importa: si la consulta no encuentra nada, la respuesta
  // ofrece guardar el texto tal cual y queda esperando un toque. No se pierde
  // nada, solo deja de guardarse por accidente.
  if (text) {
    return { verb: 'recordar', query: contentWords(text) || normalize(text), adivinado: true };
  }
  return { verb: 'capturar', text: null, attachment: null };
}
