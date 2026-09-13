'use client';
import { useState } from 'react';
import { ApiError, type Affected } from '@/shared/api/client';
import { useDomains } from '@/features/domains/queries';
import { useExtract } from '@/features/facts/queries';
import { Confirm, Failed, Panel, Spinner, Tag, day } from '@/shared/ui/primitives';
import { useCurate, useHide, useMemory, usePurge } from './queries';

/**
 * One memory, and the four things about it you are allowed to overrule.
 *
 * Note and transcription are shown and never editable: the note is yours and is
 * never regenerated (§4), and the text is derived from the blob — editing it
 * would make it stop being derived, and the honest fix is reprocessing.
 */
export function MemoryDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useMemory(id);
  const domains = useDomains();
  const curate = useCurate(id);
  const hide = useHide(id);
  const purge = usePurge(id);
  const extract = useExtract();
  const [pending, setPending] = useState<{ message: string; affects: Affected[] } | null>(null);

  if (detail.isLoading) return <Panel title="…"><Spinner /></Panel>;
  if (detail.isError) return <Panel title="Error"><Failed error={detail.error} onRetry={() => detail.refetch()} /></Panel>;

  const m = detail.data!.memory;
  const facts = detail.data!.facts;

  /** Purging asks first: the server answers 409 naming what would disappear. */
  const askPurge = () => {
    purge.mutate(false, {
      onError: (e) => {
        if (e instanceof ApiError && e.needsConfirmation) setPending({ message: e.message, affects: e.affects });
      },
    });
  };

  return (
    <Panel
      title={m.title ?? m.originalFilename ?? '(sin título)'}
      action={<button onClick={onClose}>cerrar</button>}
    >
      <dl className="facts-grid">
        <dt>categoría</dt>
        <dd>
          <select
            value={domains.data?.find((d) => d.label === m.domainLabel)?.slug ?? ''}
            onChange={(e) => curate.mutate({ domain: e.target.value || null })}
            disabled={curate.isPending}
          >
            <option value="">sin categoría</option>
            {(domains.data ?? []).map((d) => <option key={d.slug} value={d.slug}>{d.label}</option>)}
          </select>
        </dd>

        <dt>fecha del hecho</dt>
        <dd>
          <input
            type="date"
            defaultValue={m.occurredAt?.slice(0, 10) ?? ''}
            onBlur={(e) => curate.mutate({ occurredAt: e.target.value || null })}
          />
          <span className="muted"> capturada {day(m.capturedAt)}</span>
        </dd>

        <dt>título</dt>
        <dd>
          <input
            defaultValue={m.title ?? ''}
            onBlur={(e) => curate.mutate({ title: e.target.value })}
            aria-label="título"
          />
        </dd>

        <dt>archivo</dt>
        <dd>
          {m.mediaType ? (
            <a href={`/api/memories/${m.id}/blob`} target="_blank" rel="noreferrer">
              {m.originalFilename ?? 'abrir'} ({m.mediaType})
            </a>
          ) : <span className="muted">solo nota</span>}
        </dd>
      </dl>

      {curate.isError && <Failed error={curate.error} />}

      {m.note && (
        <>
          <h3>Tu nota</h3>
          {/* Se muestra y no se edita: §4 dice que nunca se regenera ni se pisa. */}
          <p className="note">{m.note}</p>
        </>
      )}

      <h3>
        Datos duros
        <button className="link" onClick={() => extract.mutate(id)} disabled={extract.isPending}>
          {extract.isPending ? 'releyendo…' : 'volver a extraer'}
        </button>
      </h3>
      {facts.length === 0 && <p className="muted">Ningún tipo aplica a este documento.</p>}
      {facts.map((f) => (
        <div key={f.id} className="fact">
          <strong>{f.typeLabel}</strong>{' '}
          <span className="muted">{day(f.validFrom)} → {day(f.validUntil)}</span>
          {f.supersededBy && <Tag>superado</Tag>}
          <dl className="facts-grid">
            {Object.entries(f.payload).map(([k, v]) => (
              <div key={k} className="contents"><dt>{k}</dt><dd>{String(v)}</dd></div>
            ))}
          </dl>
        </div>
      ))}

      {m.normalizedText && (
        <details>
          <summary>Lo que leyó ({m.normalizationLane})</summary>
          <pre className="raw">{m.normalizedText.slice(0, 4000)}</pre>
        </details>
      )}

      <div className="row end danger-row">
        <button onClick={() => hide.mutate(!m.hidden)} disabled={hide.isPending}>
          {m.hidden ? 'volver a mostrar' : 'ocultar'}
        </button>
        <button className="danger" onClick={askPurge}>purgar</button>
      </div>

      {pending && (
        <Confirm
          message={pending.message}
          affects={pending.affects}
          busy={purge.isPending}
          onCancel={() => setPending(null)}
          onConfirm={() => purge.mutate(true, { onSuccess: () => { setPending(null); onClose(); } })}
        />
      )}
    </Panel>
  );
}
