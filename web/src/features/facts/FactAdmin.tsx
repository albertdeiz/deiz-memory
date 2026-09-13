'use client';
import { useState } from 'react';
import { ApiError, type Affected } from '@/shared/api/client';
import { Confirm, Empty, Failed, Panel, Spinner, Tag, day } from '@/shared/ui/primitives';
import type { TypeProposal } from '@/shared/api/types';
import { useAcceptProposal, useFactTypes, useFacts, useProposals } from './queries';

export function FactAdmin() {
  const facts = useFacts(true);
  const types = useFactTypes();
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
            <li key={t.slug} className="row between">
              <span>
                <strong>{t.slug}</strong>{' '}
                <Tag>{t.kind === 'state' ? 'estado' : 'período'}</Tag>{' '}
                <span className="muted">← {t.domainSlug}</span>
              </span>
              <span className="muted">{t.fields.length} campos</span>
            </li>
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
