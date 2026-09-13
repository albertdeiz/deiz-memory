'use client';
import { useState } from 'react';
import { useMemories, type Filters } from './queries';
import { useDomains } from '@/features/domains/queries';
import { Empty, Failed, Panel, Spinner, Tag, day } from '@/shared/ui/primitives';

/**
 * The screen §6.1 says the chat cannot be: four hundred memories at once.
 *
 * Filters live in the URL-shaped state and not in a store, because the only
 * thing that needs to survive a reload is which slice you were looking at.
 */
export function MemoryList({ onOpen }: { onOpen: (id: string) => void }) {
  const [filters, setFilters] = useState<Filters>({ limit: 50 });
  const memories = useMemories(filters);
  const domains = useDomains();

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch, offset: 0 }));

  return (
    <Panel
      title="Memorias"
      action={
        <div className="row">
          <input
            placeholder="buscar…"
            defaultValue={filters.q ?? ''}
            onChange={(e) => set({ q: e.target.value })}
            aria-label="buscar"
          />
          <select
            value={filters.domain ?? ''}
            onChange={(e) => set({ domain: e.target.value || null })}
            aria-label="categoría"
          >
            <option value="">todas</option>
            {(domains.data ?? []).map((d) => (
              <option key={d.slug} value={d.slug}>{d.label}</option>
            ))}
          </select>
        </div>
      }
    >
      {memories.isError && <Failed error={memories.error} onRetry={() => memories.refetch()} />}
      {memories.isLoading && <Spinner />}
      {memories.data?.length === 0 && (
        <Empty>
          {filters.q ? 'Nada coincide.' : 'Nada guardado todavía. Se captura por el chat.'}
        </Empty>
      )}

      <ul className="rows">
        {(memories.data ?? []).map((m) => (
          <li key={m.id}>
            <button className="row-item" onClick={() => onOpen(m.id)}>
              <span className="row-main">
                <strong>{m.title ?? m.originalFilename ?? '(sin título)'}</strong>
                {m.excerpt && <span className="muted ellipsis">{m.excerpt}</span>}
              </span>
              <span className="row-meta">
                {/* La fecha del hecho manda sobre la de captura (§3.3). */}
                <span className="muted">{day(m.occurredAt ?? m.capturedAt)}</span>
                {m.domainLabel ? <Tag>{m.domainLabel}</Tag> : <Tag>sin categoría</Tag>}
                {m.hidden && <Tag>oculta</Tag>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
