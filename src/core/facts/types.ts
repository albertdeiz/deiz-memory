import type { Uuid } from '../domain/types.js';

/**
 * Los tipos de hecho (§4).
 *
 * Un tipo no es un enum, por la misma razón que un dominio no lo es (§3.7):
 * agregar `poliza_salud` no puede requerir un deploy. El registro vive en
 * `fact_types` y el prompt de extracción se arma en runtime desde él.
 */

/**
 * Qué clase de dato es un campo.
 *
 * Conjunto cerrado y chico a propósito: cada `kind` hace dos trabajos —le dice
 * al modelo qué forma tiene el campo, y **valida** lo que vuelve—. Uno abierto
 * dejaría la validación sin nada contra qué comprobar.
 */
export type FieldKind = 'text' | 'number' | 'uf' | 'money' | 'date' | 'phone';

export interface FactField {
  name: string;
  kind: FieldKind;
  label: string;
  /**
   * Las palabras con que se pregunta por este campo.
   *
   * Es lo que conecta una pregunta con un campo **sin llamar a un modelo**: si
   * una palabra de la pregunta calza con un alias, hay camino de hecho.
   * Determinista, como todo lo que decide algo acá.
   */
  aliases: string[];
}

/**
 * `estado` tiene uno vigente: la póliza nueva sucede a la vieja, que sigue
 * existiendo y sigue respondiendo "¿qué cubría el año pasado?".
 *
 * `periodo` coexiste: la cartola de agosto NO reemplaza a la de julio, porque
 * la de julio sigue siendo la verdad sobre julio para siempre. Sin esta
 * distinción el sistema marcaría julio como superada, que es peor que no tener
 * el dato.
 */
export type FactKind = 'estado' | 'periodo';

export interface FactType {
  id: Uuid;
  slug: string;
  label: string;
  description: string;
  kind: FactKind;
  /** De qué categoría intentar extraer. Null = de cualquiera. */
  domainSlug: string | null;
  fields: FactField[];
  /** Cuál de los campos distingue dos instancias. */
  identityField: string | null;
  /** De qué campos salen las fechas de vigencia. El tipo es data, su ventana también. */
  validFromField: string | null;
  validUntilField: string | null;
  active: boolean;
}

/** Un valor extraído, ya validado y normalizado. */
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
  /** Para citar. Se resuelve al leer, no se guarda duplicado. */
  shortId: string;
  memoryTitle: string | null;
}
