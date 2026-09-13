import type { Actor, Uuid } from '../domain/types';
import { shortId } from '../domain/types';
import type { Deps } from '../ports';
import { err, ok, type Result } from '../result';
import { findDomain } from './domains';
import { resolveMemoryId } from './resolve';

/**
 * Correcting what the classifier got wrong (§15).
 *
 * The classifier is right most of the time and wrong in public: a misfiled
 * memory is invisible in its category and shows up in another. Until now the
 * only fix was re-running the model and hoping, which is not a fix.
 *
 * **What can be corrected is deliberately short**: the category, the date of the
 * fact, the title and the tags. Every one of them is a *judgement* the system
 * made and you can overrule.
 *
 * What is NOT here is anything the system did not judge. `note` is yours and is
 * never regenerated or overwritten (§4), so there is nothing to correct.
 * `normalized_text` is derived from the blob and correcting it by hand would
 * make it stop being derived — the honest fix there is `dm reprocess`, which
 * reads the original again. And the blob itself is untouchable (§3.6).
 */

export interface CurateInput {
  /** A domain slug, or null to leave it uncategorised. `undefined` leaves it alone. */
  domain?: string | null;
  title?: string | null;
  /** ISO date. The date of the FACT, not of the capture, which never moves. */
  occurredAt?: string | null;
  tags?: string[];
}

export interface CurateResult {
  id: Uuid;
  shortId: string;
  changed: string[];
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function curateMemory(
  deps: Deps,
  actor: Actor,
  ref: string,
  input: CurateInput,
): Promise<Result<CurateResult>> {
  const resolved = await resolveMemoryId(deps.db, actor, ref);
  if (!resolved.ok) return resolved;
  const id = resolved.value;

  const sets: string[] = [];
  const params: unknown[] = [id, actor.ownerId];
  const changed: string[] = [];
  const add = (sql: string, value: unknown, name: string): void => {
    params.push(value);
    sets.push(`${sql} = $${params.length}`);
    changed.push(name);
  };

  if (input.domain !== undefined) {
    if (input.domain === null) {
      add('domain_id', null, 'domain');
    } else {
      // By slug and not by id, because a slug is what a person has in hand. The
      // domain must be this owner's: findDomain already filters, and a category
      // from someone else would be a cross-owner write.
      const domain = await findDomain(deps.db, actor, input.domain);
      if (!domain) return err('not_found', `No existe la categoría "${input.domain}".`);
      add('domain_id', domain.id, 'domain');
    }
    // A category set by hand is not a guess, and leaving the model's confidence
    // behind would make a corrected memory look uncertain forever.
    params.push(input.domain === null ? null : 1);
    sets.push(`domain_confidence = $${params.length}`);
  }

  if (input.title !== undefined) {
    const t = input.title?.trim() ?? null;
    add('title', t && t.length > 0 ? t.slice(0, 200) : null, 'title');
  }

  if (input.occurredAt !== undefined) {
    if (input.occurredAt === null) {
      add('occurred_at', null, 'occurredAt');
    } else {
      if (!ISO_DAY.test(input.occurredAt)) {
        return err('invalid', 'La fecha del hecho va en formato YYYY-MM-DD.');
      }
      const d = new Date(`${input.occurredAt}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) return err('invalid', `"${input.occurredAt}" no es una fecha.`);
      add('occurred_at', d, 'occurredAt');
    }
  }

  if (input.tags !== undefined) {
    const tags = [...new Set(
      input.tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0 && t.length <= 40),
    )].slice(0, 20);
    add('tags', tags, 'tags');
  }

  if (sets.length === 0) return err('invalid', 'No hay nada que corregir.');

  const { rowCount } = await deps.db.query(
    `update memories set ${sets.join(', ')}, updated_at = now()
      where id = $1 and owner_id = $2`,
    params,
  );
  if (rowCount === 0) return err('not_found', `No existe la memoria ${ref}.`);

  return ok({ id, shortId: shortId(id), changed });
}
