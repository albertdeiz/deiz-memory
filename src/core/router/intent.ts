import type { Attachment, Incoming } from '../channel/types';
import { isAbsolute, parseAction, type Action } from './actions';

/**
 * The verbs, decided with pure logic.
 *
 * This lives in the core and not in the adapter for the same reason as the lane
 * router: what the system does when you send it something is a product rule, not
 * a detail of one chat platform. Being pure, it is tested end to end with no
 * database, no network and no bot token.
 */
export type Intent =
  | { verb: 'capture'; text: string | null; attachment: Attachment | null }
  | { verb: 'recall'; query: string; guessed: boolean }
  | { verb: 'action'; action: Action }
  | { verb: 'pair'; code: string }
  | { verb: 'pending' }
  | { verb: 'review' }
  | { verb: 'domains' }
  | { verb: 'propose' }
  | { verb: 'createDomain'; label: string; description: string }
  | { verb: 'describeDomain'; ref: string; description: string }
  | { verb: 'renameDomain'; ref: string; label: string }
  | { verb: 'archiveDomain'; ref: string }
  | { verb: 'mergeDomains'; from: string; into: string }
  | { verb: 'inDomain'; ref: string }
  | { verb: 'help' };
// A 'clarify' verb does not exist yet: nothing asks the person a question.

const normalize = (s: string): string =>
  s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Words that add nothing to a text query and do dirty the ranking. */
const STOP = new Set([
  'cual', 'cuales', 'que', 'cuando', 'donde', 'cuanto', 'cuanta', 'quien', 'como',
  'tengo', 'tienes', 'busca', 'buscar', 'encuentra', 'encontrar', 'muestra',
  'shown', 'dame', 'hay', 'es', 'el', 'la', 'los', 'las', 'de', 'del', 'mi',
  'mis', 'un', 'una', 'y', 'o', 'a', 'en', 'para', 'por',
]);

/** Keeps only the words with content. If none survive, there is no search. */
export function contentWords(text: string): string {
  return normalize(text)
    .replace(/[¿?¡!.,;:]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .join(' ')
    .trim();
}

export interface Session {
  /** Ids of the last page shown, so "view 3" means something. */
  ids: string[];
  hasConfirm: boolean;
  /**
   * There is text waiting for you to say "save".
   *
   * It counts as something on screen, exactly like a list. Without it, typing
   * `save` — rather than pressing the button — was not an action, fell through
   * to free text, and the offer was lost. With free text turned into a query,
   * that escape hatch is the only thing holding up "nothing is lost".
   */
  hasSave: boolean;
}

/**
 * From the most explicit to the most ambiguous. The order IS the rule: a command
 * always wins, and only at the end is free text decided on.
 */
export function classify(msg: Incoming, session: Session | null): Intent {
  const pending =
    (session?.ids.length ?? 0) > 0 || session?.hasConfirm === true || session?.hasSave === true;

  // 1 · a button already pressed is not interpreted, it is obeyed
  if (msg.action) {
    const a = parseAction(msg.action, true);
    if (a) return { verb: 'action', action: a };
  }

  const text = msg.text?.trim() ?? '';

  // 2 · explicit commands
  if (text.startsWith('/')) {
    const [rawCmd, ...rest] = text.slice(1).split(/\s+/);
    const cmd = normalize(rawCmd ?? '');
    const arg = rest.join(' ').trim();

    // The commands are the CLI's, one per operation. Two names for the same
    // thing is one more thing to keep in sync forever.
    if (cmd === 'start') return { verb: 'pair', code: arg };
    if (cmd === 'help') return { verb: 'help' };

    // Saving is explicit: this is the only way bare text enters the corpus.
    // See the note further down.
    if (cmd === 'capture') return { verb: 'capture', text: arg || null, attachment: null };

    // Search lists; ask answers with a citation. Worth having both within
    // reach: sometimes you want the datum and sometimes the documents.
    if (cmd === 'search') return { verb: 'recall', query: arg, guessed: false };
    if (cmd === 'ask') return { verb: 'recall', query: contentWords(arg) || arg, guessed: true };

    if (cmd === 'pending') return { verb: 'pending' };
    if (cmd === 'review') return { verb: 'review' };
    if (cmd === 'more') return { verb: 'action', action: { kind: 'more' } };
    if (cmd === 'domains') return { verb: 'domains' };
    if (cmd === 'propose') return { verb: 'propose' };

    // Category management from the chat, which is where it belongs: adding one
    // must not require a keyboard any more than it requires a deploy.
    //
    // The separator is `:` and not a second positional argument because both the
    // name and the description contain spaces, and demanding quotes from someone
    // typing on a phone is asking them not to use it.
    if (cmd === 'create') {
      const [nombre, ...resto] = arg.split(':');
      return { verb: 'createDomain', label: (nombre ?? '').trim(), description: resto.join(':').trim() };
    }
    if (cmd === 'describe') {
      const [ref, ...resto] = arg.split(':');
      return { verb: 'describeDomain', ref: (ref ?? '').trim(), description: resto.join(':').trim() };
    }
    if (cmd === 'rename') {
      const [ref, ...resto] = arg.split(/\s+/);
      return { verb: 'renameDomain', ref: ref ?? '', label: resto.join(' ').trim() };
    }
    if (cmd === 'archive') return { verb: 'archiveDomain', ref: arg };
    if (cmd === 'merge') {
      const [from, into] = arg.split(/\s+/);
      return { verb: 'mergeDomains', from: from ?? '', into: into ?? '' };
    }
    // Any other /slug means "show me that category". Resolved against the
    // table, not against a list in the code — which is the entire point of
    // categories being data.
    if (/^[a-z0-9-]{2,32}$/.test(cmd)) return { verb: 'inDomain', ref: cmd };
    return { verb: 'help' };
  }

  // 3 · an action word, but only when something on screen is waiting for it.
  //     This is the branch that makes button-free degradation real.
  if (!msg.attachment && text) {
    // Only with something on screen: with no list, "more" or "2" is text.
    //
    // Unless it names an id. `view:a3f2c1d0` points at itself, so it means the
    // same thing with an empty conversation as with five results on screen —
    // the same reason a button can carry one and survive the list it came from.
    const a = parseAction(text, pending);
    if (a && (pending || isAbsolute(a))) return { verb: 'action', action: a };
  }

  // 4 · there is a file: it gets stored, and the text becomes its note
  if (msg.attachment) {
    return { verb: 'capture', text: text || null, attachment: msg.attachment };
  }

  // 5 · free text: queried, not stored.
  //
  // **This inverts the default toward capture, on purpose and from real use.**
  // Resolving ambiguity toward storing is right for a channel where a message
  // arrives with no declared intent. A conversation is not that: what you type
  // in a chat is, almost always, something you are asking someone. Guessing with
  // a heuristic — does it start with a question word? — was right about half the
  // time and left questions stored as memories, to be hidden by hand later.
  //
  // Saving becomes explicit: a file, or the capture command. And the spirit of
  // losing nothing holds where it matters: if the query finds nothing, the answer
  // offers to store the text as it stands, one tap away. Nothing is lost, it just
  // stops being stored by accident.
  if (text) {
    return { verb: 'recall', query: contentWords(text) || normalize(text), guessed: true };
  }
  return { verb: 'capture', text: null, attachment: null };
}
