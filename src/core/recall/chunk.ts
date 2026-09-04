/**
 * Splitting a document into searchable chunks.
 *
 * Why chunks and not whole documents: a policy of eighty thousand characters
 * averaged into a single vector resembles nothing in particular. The question
 * "what is my deductible?" needs to hit the deductible paragraph, and for that
 * the paragraph has to exist as a separate thing.
 *
 * Pure logic, like the lane router: how a document is cut is a product decision
 * and is tested with no database and no network.
 */

/** Not so short it loses context, not so long it dilutes the vector. */
export const TARGET_CHARS = 900;

/**
 * A little overlap between consecutive chunks.
 *
 * Without it, a datum landing exactly on a cut ends up split across two halves
 * and neither half resembles the question. Cheap, and it avoids the dumbest
 * failure mode of chunking.
 */
export const OVERLAP_CHARS = 150;

/** Below this a chunk contributes nothing and only dirties results. */
const MIN_CHARS = 40;

export interface Chunk {
  seq: number;
  content: string;
}

/**
 * Cuts on paragraphs first, and only splits a paragraph that does not fit.
 *
 * A document already carries its own structure — the document lane preserves
 * headings and tables — and respecting it produces chunks that mean something.
 * Cutting blindly every 900 characters splits tables down the middle.
 */
export function chunkText(text: string): Chunk[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length === 0) return [];
  if (clean.length <= TARGET_CHARS) return [{ seq: 0, content: clean }];

  const paragraphs = clean.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let current = '';

  const push = () => {
    const t = current.trim();
    if (t.length >= MIN_CHARS) chunks.push(t);
    else if (t.length > 0 && chunks.length > 0) chunks[chunks.length - 1] += `\n\n${t}`;
    current = '';
  };

  for (const p of paragraphs) {
    const paragraph = p.trim();

    // A paragraph that does not fit on its own gets split hard, but only after
    // trying to respect the structure.
    if (paragraph.length > TARGET_CHARS) {
      push();
      for (let i = 0; i < paragraph.length; i += TARGET_CHARS - OVERLAP_CHARS) {
        const piece = paragraph.slice(i, i + TARGET_CHARS).trim();
        if (piece.length >= MIN_CHARS) chunks.push(piece);
        if (i + TARGET_CHARS >= paragraph.length) break;
      }
      continue;
    }

    if (current.length + paragraph.length + 2 > TARGET_CHARS) push();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  push();

  return chunks.map((content, seq) => ({ seq, content }));
}

/**
 * What gets sent to the embedder.
 *
 * **The chunk alone.** The temptation is to prefix each one with the title and
 * the note for context, and it backfires: if all eighty chunks of a policy start
 * with "car policy, insurer X", all eighty resemble each other and none stands
 * out when asked about the deductible. Shared context distinguishes nothing —
 * what distinguishes is what each chunk has of its own.
 *
 * The context arrives anyway, by the other path: full-text search does index
 * title and note at the highest weight, and fusing the two paths joins both
 * signals.
 */
export function contextualize(chunk: string): string {
  return chunk;
}
