import type { Uuid } from '../domain/types';

/**
 * Fact types.
 *
 * A type is not an enum, for the same reason a domain is not: adding one must
 * not require a deploy. The registry lives in the database and the extraction
 * prompt is built from it at runtime.
 */

/**
 * What kind of datum a field is.
 *
 * A small closed set on purpose: each kind does two jobs — it tells the model
 * what shape the field has, and it **validates** what comes back. An open set
 * would leave validation with nothing to check against.
 */
export type FieldKind = 'text' | 'number' | 'uf' | 'money' | 'date' | 'phone';

export interface FactField {
  name: string;
  kind: FieldKind;
  label: string;
  /**
   * The words people use to ask for this field.
   *
   * This is what connects a question to a field **without calling a model**: if
   * a word of the question matches an alias, there is a fact path. Matching is
   * by stem and prefix, so asking with a different conjugation still lands.
   */
  aliases: string[];
  /**
   * Words that have to appear **near the value** in the document.
   *
   * Checking that the figure exists is not enough: a card statement carries both
   * `MONTO FACTURADO A PAGAR (PERÍODO ANTERIOR) $886.568` and `MONTO TOTAL
   * FACTURADO A PAGAR $1.747.885`, and both figures are in the text. Without
   * looking at the label, the guard accepted last month's.
   */
  near?: string[];
  /**
   * Words that **disqualify** an occurrence.
   *
   * This is the half that actually matters, because the decoy's label usually
   * contains the good one: "amount billed" sits inside "amount billed (previous
   * period)". What separates them is the extra word.
   */
  notNear?: string[];
}

/**
 * `state` has one current version: a new policy succeeds the old one, which
 * still exists and still answers "what did it cover last year?".
 *
 * `period` coexists: August's statement does NOT replace July's, because July's
 * is still the truth about July, permanently. Without this distinction the
 * system would mark July superseded, which is worse than not having the datum.
 */
export type FactKind = 'state' | 'period';

/**
 * How many facts of this type one document carries.
 *
 * A second axis, not a flavour of `kind`, and confusing them is the same mistake
 * as confusing state with period. `kind` answers "does a new one supersede the
 * old?"; this answers "how many does one document hold?". A bus ticket is
 * `period` AND `many`: one PDF carries two passengers, and September's does not
 * replace August's.
 *
 * `many` requires an `identityField`. Without one, two rows from the same
 * document are indistinguishable and the upsert collapses them — the second
 * datum disappears without anything failing, which is the worst way to lose it.
 */
export type Cardinality = 'one' | 'many';

export interface FactType {
  id: Uuid;
  slug: string;
  label: string;
  description: string;
  kind: FactKind;
  cardinality: Cardinality;
  /** Which category to try extracting from. Null means any. */
  domainSlug: string | null;
  fields: FactField[];
  /** Which field distinguishes two instances. */
  identityField: string | null;
  /** Where the validity dates come from. The type is data; so is its window. */
  validFromField: string | null;
  validUntilField: string | null;
  active: boolean;
}

/** An extracted value, already validated and normalized. */
export type FactValue = string | number;

export interface Fact {
  id: Uuid;
  memoryId: Uuid;
  typeId: Uuid;
  typeSlug: string;
  typeLabel: string;
  kind: FactKind;
  payload: Record<string, FactValue>;
  identity: string | null;
  validFrom: Date | null;
  validUntil: Date | null;
  supersededBy: Uuid | null;
  confidence: number;
  /** For citing. Resolved on read, not stored twice. */
  shortId: string;
  memoryTitle: string | null;
}
