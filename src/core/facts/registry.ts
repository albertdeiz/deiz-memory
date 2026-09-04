import type { Actor, Uuid } from '../domain/types.js';
import type { Db } from '../ports.js';
import type { FactField, FactType } from './types.js';

interface Row {
  id: string; slug: string; label: string; description: string; kind: string;
  domain_slug: string | null; fields: FactField[]; identity_field: string | null;
  valid_from_field: string | null; valid_until_field: string | null; active: boolean;
}

const toType = (r: Row): FactType => ({
  id: r.id,
  slug: r.slug,
  label: r.label,
  description: r.description,
  kind: r.kind as FactType['kind'],
  domainSlug: r.domain_slug,
  fields: r.fields ?? [],
  identityField: r.identity_field,
  validFromField: r.valid_from_field,
  validUntilField: r.valid_until_field,
  active: r.active,
});

const COLUMNS = `id, slug, label, description, kind, domain_slug, fields,
                 identity_field, valid_from_field, valid_until_field, active`;

export async function listFactTypes(
  db: Db,
  actor: Actor,
  opts: { includeInactive?: boolean } = {},
): Promise<FactType[]> {
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from fact_types
      where owner_id = $1 and ($2 or active)
      order by label`,
    [actor.ownerId, opts.includeInactive ?? false],
  );
  return rows.map(toType);
}

/**
 * Los tipos que vale la pena intentar sobre una memoria de este dominio.
 *
 * El filtro por dominio es lo que evita llamar al modelo sobre cada memoria
 * para descubrir que no aplica: una boleta del supermercado no tiene por qué
 * pasar por el extractor de pólizas.
 */
export async function typesForDomain(
  db: Db,
  ownerId: Uuid,
  domainSlug: string | null,
): Promise<FactType[]> {
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from fact_types
      where owner_id = $1 and active
        and (domain_slug is null or domain_slug = $2)`,
    [ownerId, domainSlug],
  );
  return rows.map(toType);
}

export async function findFactType(db: Db, actor: Actor, ref: string): Promise<FactType | null> {
  const clean = ref.trim().toLowerCase();
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from fact_types
      where owner_id = $1 and (slug = $2 or lower(label) = $2)`,
    [actor.ownerId, clean],
  );
  return rows[0] ? toType(rows[0]) : null;
}

/**
 * Los dos tipos semilla, sacados de documentos reales del corpus.
 *
 * `poliza_auto` es `estado` —hay una vigente— y `tarjeta_credito` es `periodo`
 * —la de agosto no reemplaza a la de julio—. Están los dos desde el principio a
 * propósito: un solo tipo dejaría la rama de `periodo` sin ejercitar, y es
 * justo la que se descubrió tarde.
 */
export const SEED_FACT_TYPES: Omit<FactType, 'id' | 'active'>[] = [
  {
    slug: 'poliza_auto',
    label: 'Póliza de auto',
    kind: 'estado',
    description:
      'El CONTRATO de seguro de un vehículo: el documento que la aseguradora emite al ' +
      'contratar, con las coberturas, los deducibles y la vigencia. Tiene que nombrar la ' +
      'patente del vehículo asegurado. ' +
      'NO es de este tipo un informe de liquidación de siniestro, un certificado de ' +
      'cobertura, ni una cotización: esos hablan DE una póliza, pero no la son.',
    domainSlug: 'seguros',
    identityField: 'patente',
    validFromField: 'vigencia_desde',
    validUntilField: 'vigencia_hasta',
    fields: [
      { name: 'numero', kind: 'text', label: 'número de póliza', aliases: ['poliza', 'numero'] },
      { name: 'patente', kind: 'text', label: 'patente del vehículo', aliases: ['patente', 'placa'] },
      { name: 'deducible', kind: 'uf', label: 'deducible por siniestro', aliases: ['deducible', 'franquicia'] },
      { name: 'vigencia_desde', kind: 'date', label: 'inicio de vigencia', aliases: ['vigencia', 'inicio'] },
      { name: 'vigencia_hasta', kind: 'date', label: 'término de vigencia', aliases: ['vence', 'vencimiento', 'expira', 'termino'] },
      { name: 'asistencia', kind: 'phone', label: 'teléfono de asistencia', aliases: ['asistencia', 'grua', 'emergencia'] },
    ],
  },
  {
    slug: 'tarjeta_credito',
    label: 'Estado de cuenta de tarjeta',
    kind: 'periodo',
    description:
      'Estado de cuenta o cartola mensual de una tarjeta de crédito: cupo, monto facturado, ' +
      'fecha de pago y tasas. Un documento por mes.',
    domainSlug: 'finanzas',
    identityField: 'tarjeta',
    validFromField: 'periodo_desde',
    validUntilField: 'periodo_hasta',
    fields: [
      // Sin alias a propósito: "tarjeta" está en el nombre del tipo, así que
      // como alias hacía que toda pregunta sobre la tarjeta arrastrara sus
      // dígitos. La identidad se muestra al lado del dato, que es donde sirve.
      { name: 'tarjeta', kind: 'text', label: 'últimos dígitos de la tarjeta', aliases: [] },
      // El rótulo del señuelo contiene al del bueno —"monto facturado a pagar
      // (período anterior)"— así que lo que los separa es `notNear`.
      { name: 'monto_a_pagar', kind: 'money', label: 'monto TOTAL facturado a pagar de este período',
        aliases: ['pagar', 'monto', 'facturado', 'deuda'],
        near: ['total facturado a pagar'], notNear: ['anterior', 'minimo', 'pagado', 'cancelado'] },
      { name: 'pagar_hasta', kind: 'date', label: 'fecha límite de pago', aliases: ['vence', 'vencimiento', 'plazo'],
        near: ['pagar hasta'] },
      { name: 'cupo_total', kind: 'money', label: 'cupo total', aliases: ['cupo'] },
      { name: 'cupo_disponible', kind: 'money', label: 'cupo disponible', aliases: ['disponible'] },
      { name: 'tasa', kind: 'number', label: 'tasa de interés vigente (%)', aliases: ['tasa', 'interes'] },
      { name: 'periodo_desde', kind: 'date', label: 'inicio del período facturado', aliases: ['periodo'],
        near: ['periodo  facturado', 'periodo facturado'], notNear: ['anterior'] },
      { name: 'periodo_hasta', kind: 'date', label: 'fin del período facturado', aliases: ['periodo'],
        near: ['periodo  facturado', 'periodo facturado'], notNear: ['anterior'] },
    ],
  },
];

export async function seedFactTypes(db: Db, ownerId: Uuid): Promise<void> {
  for (const t of SEED_FACT_TYPES) {
    await db.query(
      `insert into fact_types
         (owner_id, slug, label, description, kind, domain_slug, fields,
          identity_field, valid_from_field, valid_until_field)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
       on conflict (owner_id, slug) do nothing`,
      [ownerId, t.slug, t.label, t.description, t.kind, t.domainSlug,
       JSON.stringify(t.fields), t.identityField, t.validFromField, t.validUntilField],
    );
  }
}
