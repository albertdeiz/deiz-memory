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
  | { verb: 'enDominio'; ref: string }
  | { verb: 'ayuda' };
// 'aclarar' (§5) todavía no existe: no hay clasificador que dude. Llega en F2.

/**
 * Palabras con las que la gente empieza una pregunta. Sin tildes porque el
 * texto llega normalizado.
 */
const ASKING = /^(cual|cuales|que|cuando|donde|cuanto|cuanta|quien|como|tengo|tienes|busca|buscar|encuentra|encontrar|muestra|mostrar|dame|hay)\b/;

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

/**
 * Si un texto suelto es una pregunta o algo que guardar.
 *
 * **Acá hay una desviación consciente de §5, y conviene que esté escrita.** §5
 * dice que la ambigüedad se resuelve siempre a favor de capturar. Pero en esta
 * fase la pregunta en lenguaje natural todavía no existe —es F3—, y guardar
 * "¿cuál es mi deducible?" como si fuera una memoria es doblemente malo: no
 * responde, y deja basura en el corpus que después hay que ocultar a mano.
 *
 * Así que la regla es estrecha: empieza con `¿`, o con una palabra de pregunta,
 * y no trae archivo. Todo lo demás se guarda, como manda §5.
 *
 * Y el espíritu de §5 se respeta igual donde importa: si la búsqueda no
 * encuentra nada, la respuesta ofrece guardarlo, y el texto queda esperando un
 * toque. No se pierde nada.
 */
export const looksLikeQuestion = (text: string): boolean => {
  const t = text.trim();
  if (t.startsWith('¿')) return true;
  return ASKING.test(normalize(t)) && contentWords(t).length > 0;
};

export interface Session {
  /** Ids de la última página mostrada, para que "ver 3" signifique algo. */
  ids: string[];
  hasConfirm: boolean;
}

/**
 * De lo más explícito a lo más ambiguo. El orden es la regla: un comando gana
 * siempre, y solo al final se decide sobre texto libre.
 */
export function classify(msg: Incoming, session: Session | null): Intent {
  const pending = (session?.ids.length ?? 0) > 0 || session?.hasConfirm === true;

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

    if (cmd === 'start' || cmd === 'empezar') return { verb: 'parear', code: arg };
    if (cmd === 'buscar' || cmd === 'busca') return { verb: 'recordar', query: arg, adivinado: false };
    if (cmd === 'pendientes') return { verb: 'pendientes' };
    if (cmd === 'revisar' || cmd === 'revision') return { verb: 'revisar' };
    if (cmd === 'exportar') return { verb: 'accion', action: { kind: 'exportar' } };
    if (cmd === 'mas') return { verb: 'accion', action: { kind: 'mas' } };
    if (cmd === 'ayuda' || cmd === 'help') return { verb: 'ayuda' };
    if (cmd === 'dominios' || cmd === 'categorias') return { verb: 'dominios' };
    // Cualquier otro /slug es "muéstrame lo de esa categoría" (§9). Se resuelve
    // contra la tabla, no contra una lista en el código — que es el punto
    // entero de que los dominios sean data.
    if (/^[a-z0-9-]{2,32}$/.test(cmd)) return { verb: 'enDominio', ref: cmd };
    return { verb: 'ayuda' };
  }

  // 3 · una palabra de acción, pero solo si hay algo en pantalla esperándola.
  //     Es la rama que hace real la degradación sin botones.
  if (!msg.attachment && text) {
    const a = parseAction(text, pending);
    if (a && (pending || a.kind === 'exportar')) return { verb: 'accion', action: a };
  }

  // 4 · hay archivo: se guarda, y el texto va de nota
  if (msg.attachment) {
    return { verb: 'capturar', text: text || null, attachment: msg.attachment };
  }

  // 5 · texto libre
  if (text && looksLikeQuestion(text)) {
    // `adivinado`: lo tratamos como pregunta por una heurística, así que si no
    // encuentra nada hay que ofrecer guardarlo. Es lo que mantiene el espíritu
    // de §5 —no perder nada— sin ensuciar el corpus con preguntas.
    return { verb: 'recordar', query: contentWords(text), adivinado: true };
  }
  return { verb: 'capturar', text: text || null, attachment: null };
}
