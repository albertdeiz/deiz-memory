'use client';
import { Empty, Failed, Panel, Spinner, Tag, day } from '@/shared/ui/primitives';
import { useOverview, useReview } from './queries';

/** What is wrong right now, which is the only reason to open an admin tool. */
export function Overview({ onOpen }: { onOpen: (id: string) => void }) {
  const overview = useOverview();
  const review = useReview();
  const b = overview.data?.backup;

  const pending = typeof overview.data?.pendingReview === 'object'
    ? overview.data.pendingReview.needsReview
    : overview.data?.pendingReview ?? 0;

  return (
    <>
      <Panel title="Estado">
        {overview.isLoading && <Spinner />}
        {overview.isError && <Failed error={overview.error} onRetry={() => overview.refetch()} />}
        {overview.data && (
          <div className="stats">
            <div><strong>{overview.data.domains.length}</strong><span>categorías</span></div>
            <div><strong>{overview.data.facts}</strong><span>datos duros</span></div>
            <div>
              <strong>{overview.data.gaps.total}</strong>
              <span>{overview.data.gaps.total === 0 ? 'sin leer' : 'nadie los lee'}</span>
            </div>
            <div><strong>{pending}</strong><span>por revisar</span></div>
            <div>
              {/* Un respaldo viejo se ve idéntico a uno sano desde cualquier otro
                  ángulo, así que la fecha va donde ya miras (§14.3). */}
              <strong>{b?.lastRunAt ? day(b.lastRunAt) : '—'}</strong>
              <span>{b ? (b.lastOk === false ? 'respaldo FALLÓ' : 'último respaldo') : 'sin respaldo'}</span>
            </div>
          </div>
        )}
        {/* Un documento legible que cayó en la categoría equivocada no produce
            ningún hecho, y eso no falla: simplemente no hay nada (§4). */}
        {overview.data && overview.data.gaps.total > 0 && (
          <p className="warn">
            <strong>{overview.data.gaps.total} documento(s) que ningún tipo sabe leer.</strong>
            <br />
            {overview.data.gaps.withoutDomain > 0 && (
              <>{overview.data.gaps.withoutDomain} sin categoría — ningún tipo puede aplicar.<br /></>
            )}
            {overview.data.gaps.domainsWithoutType.map((d) => (
              <span key={d.slug}>
                {d.memories} en {d.label} — ninguno apunta ahí.<br />
              </span>
            ))}
            Míralos en Datos duros → proponer tipos.
          </p>
        )}
        {b && !b.lastVerifiedAt && (
          <p className="warn">
            El respaldo nunca se verificó. Un respaldo que no se restauró no existe:
            <code> npm run backup -- verify</code>
          </p>
        )}
      </Panel>

      <Panel title="Lo que quedó dudoso">
        {review.isLoading && <Spinner />}
        {review.data?.length === 0 && <Empty>Nada pendiente.</Empty>}
        <ul className="rows">
          {(review.data ?? []).map((m) => (
            <li key={m.id}>
              <button className="row-item" onClick={() => onOpen(m.id)}>
                <span className="row-main">
                  <strong>{m.title ?? m.originalFilename ?? '(sin título)'}</strong>
                </span>
                <span className="row-meta">
                  <span className="muted">{day(m.capturedAt)}</span>
                  <Tag>{m.status}</Tag>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
