'use client';
import { useState } from 'react';
import { ApiError, type Affected } from '@/shared/api/client';
import { Confirm, Empty, Failed, Panel, Spinner, Tag, day } from '@/shared/ui/primitives';
import type { Domain, FactType, TypeProposal } from '@/shared/api/types';
import { useDomains } from '@/features/domains/queries';
import {
  useAcceptProposal, useArchiveFactType, useEditFactType, useFactTypes, useFacts, useProposals,
} from './queries';

/**
 * Un tipo, editable.
 *
 * Hasta ahora un tipo nacía de una semilla o de una propuesta y después era
 * inalcanzable: mover su categoría o ajustar su descripción exigía `psql`, y una
 * regla que solo se cumple abriendo una shell no es una regla.
 *
 * La descripción va en un `textarea` y no en un input porque **es el prompt**
 * (§4): es lo que el modelo lee para decidir si un documento es de este tipo.
 */
function TypeRow({ type, domains }: { type: FactType; domains: Domain[] }) {
  const edit = useEditFactType(type.slug);
  const archive = useArchiveFactType();
  const [pending, setPending] = useState<{ patch: Partial<FactType>; message: string; affects: Affected[] } | null>(null);

  // Cambiar dominio, kind o cardinality decide cómo se lee la categoría entera,
  // así que el servidor contesta 409 y acá se pregunta.
  const apply = (patch: Partial<FactType>) => {
    edit.mutate({ patch, confirm: false }, {
      onError: (e) => {
        if (e instanceof ApiError && e.needsConfirmation) {
          setPending({ patch, message: e.message, affects: e.affects });
        }
      },
    });
  };

  return (
    <li className="domain">
      <div className="row between">
        <span>
          <strong>{type.slug}</strong>{' '}
          <Tag>{type.kind === 'state' ? 'estado' : 'período'}</Tag>{' '}
          {type.cardinality === 'many' && <Tag>varios por documento</Tag>}
        </span>
        <span className="row">
          <select
            value={type.domainSlug ?? ''}
            onChange={(e) => apply({ domainSlug: e.target.value || null })}
            aria-label={`categoría de ${type.slug}`}
          >
            <option value="">cualquier categoría</option>
            {domains.map((d) => <option key={d.slug} value={d.slug}>{d.label}</option>)}
          </select>
          <button onClick={() => archive.mutate(type.slug)}>archivar</button>
        </span>
      </div>

      <textarea
        defaultValue={type.description}
        onBlur={(e) => { if (e.target.value !== type.description) apply({ description: e.target.value }); }}
        rows={2}
        aria-label={`descripción de ${type.slug}`}
      />

      <div className="muted">
        {type.fields.map((f) => (
          <span key={f.name}>
            {f.name}
            {f.name === type.identityField ? ' ←' : ''}
            {' '}
          </span>
        ))}
      </div>

      {/* Un 409 de confirmación no es un error que mostrar: es el diálogo. */}
      {edit.isError && !(edit.error instanceof ApiError && edit.error.needsConfirmation) && (
        <Failed error={edit.error} />
      )}

      {pending && (
        <Confirm
          message={pending.message}
          affects={pending.affects}
          busy={edit.isPending}
          onCancel={() => setPending(null)}
          onConfirm={() => edit.mutate(
            { patch: pending.patch, confirm: true },
            { onSuccess: () => setPending(null) },
          )}
        />
      )}
    </li>
  );
}

export function FactAdmin() {
  const facts = useFacts(true);
  const types = useFactTypes();
  const domains = useDomains();
  const [asking, setAsking] = useState(false);
  const proposals = useProposals(asking);
  const accept = useAcceptProposal();
  const [pending, setPending] = useState<{ p: TypeProposal; message: string; affects: Affected[] } | null>(null);

  const ask = (p: TypeProposal) => {
    accept.mutate({ proposal: p, confirm: false }, {
      onError: (e) => {
        if (e instanceof ApiError && e.needsConfirmation) setPending({ p, message: e.message, affects: e.affects });
      },
    });
  };

  return (
    <>
      <Panel
        title="Tipos"
        action={
          <button onClick={() => setAsking(true)} disabled={proposals.isFetching}>
            {proposals.isFetching ? 'mirando tus documentos…' : 'proponer tipos'}
          </button>
        }
      >
        {types.isLoading && <Spinner />}
        <ul className="rows">
          {(types.data ?? []).map((t) => (
            <TypeRow key={t.slug} type={t} domains={domains.data ?? []} />
          ))}
        </ul>

        {/* La propuesta cuesta una llamada al modelo por documento huérfano, así
            que nunca corre sola: se pide. */}
        {asking && proposals.isError && <Failed error={proposals.error} />}
        {asking && proposals.data?.length === 0 && (
          <Empty>Nada que proponer: todo documento con estructura ya tiene un tipo.</Empty>
        )}
        {(proposals.data ?? []).map((p) => (
          <div key={p.slug} className="proposal">
            <div className="row between">
              <strong>{p.slug}</strong>
              <button onClick={() => ask(p)}>crear este tipo</button>
            </div>
            <p className="muted">{p.description}</p>
            <p className="muted">visto en {p.fromShortId} · {p.fromTitle}</p>
            <dl className="facts-grid">
              {p.fields.map((f) => (
                <div key={f.name} className="contents">
                  <dt>{f.name}{f.name === p.identityField ? ' ←' : ''}</dt>
                  <dd>{f.label} <span className="muted">[{f.kind}] ej. {f.example}</span></dd>
                </div>
              ))}
            </dl>
            {p.discarded.length > 0 && (
              <p className="muted">descartados por no estar en el documento: {p.discarded.join(', ')}</p>
            )}
          </div>
        ))}
      </Panel>

      <Panel title="Datos duros">
        {facts.isLoading && <Spinner />}
        {facts.data?.length === 0 && <Empty>Ninguno extraído todavía.</Empty>}
        {(facts.data ?? []).map((f) => (
          <div key={f.id} className="fact">
            <div className="row between">
              <strong>{f.typeLabel}</strong>
              <span className="muted">
                {day(f.validFrom)} → {day(f.validUntil)} · {f.shortId}
              </span>
            </div>
            {f.supersededBy && <Tag>superado</Tag>}
            <dl className="facts-grid">
              {Object.entries(f.payload).map(([k, v]) => (
                <div key={k} className="contents"><dt>{k}</dt><dd>{String(v)}</dd></div>
              ))}
            </dl>
          </div>
        ))}
      </Panel>

      {pending && (
        <Confirm
          message={pending.message}
          affects={pending.affects}
          busy={accept.isPending}
          onCancel={() => setPending(null)}
          onConfirm={() => accept.mutate(
            { proposal: pending.p, confirm: true },
            { onSuccess: () => setPending(null) },
          )}
        />
      )}
    </>
  );
}
