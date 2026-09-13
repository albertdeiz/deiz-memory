'use client';
import { useState } from 'react';
import { Empty, Failed, Panel, Spinner } from '@/shared/ui/primitives';
import { useArchiveDomain, useCreateDomain, useDomains, useEditDomain } from './queries';

/**
 * Categories are rows, so this is a table (§9).
 *
 * The description is the one field worth space: it is not documentation, it is
 * the prompt the classifier reads. Editing it here is the same lever that moved
 * a misfiled manual into the right category without a deploy.
 */
export function DomainAdmin() {
  const domains = useDomains();
  const create = useCreateDomain();
  const archive = useArchiveDomain();
  const [draft, setDraft] = useState({ label: '', description: '' });

  return (
    <Panel title="Categorías">
      {domains.isLoading && <Spinner />}
      {domains.isError && <Failed error={domains.error} onRetry={() => domains.refetch()} />}
      {domains.data?.length === 0 && <Empty>Ninguna todavía.</Empty>}

      <ul className="rows">
        {(domains.data ?? []).map((d) => (
          <DomainRow key={d.slug} slug={d.slug} label={d.label} description={d.description}
                     count={d.count} onArchive={() => archive.mutate(d.slug)} />
        ))}
      </ul>

      <form
        className="new-domain"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(draft, { onSuccess: () => setDraft({ label: '', description: '' }) });
        }}
      >
        <input
          placeholder="nombre" value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })} aria-label="nombre"
        />
        <input
          placeholder="qué va acá — esto es lo que lee el clasificador"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          aria-label="descripción"
        />
        <button type="submit" disabled={!draft.label || !draft.description || create.isPending}>
          crear
        </button>
      </form>
      {create.isError && <Failed error={create.error} />}
    </Panel>
  );
}

function DomainRow({ slug, label, description, count, onArchive }: {
  slug: string; label: string; description: string; count?: number; onArchive: () => void;
}) {
  const edit = useEditDomain(slug);
  return (
    <li className="domain">
      <div className="row between">
        <strong>{label}</strong>
        <span className="row">
          <span className="muted">{count ?? 0} memorias</span>
          {/* Archivar y no borrar: borrar dejaría memorias huérfanas (§9). */}
          <button onClick={onArchive}>archivar</button>
        </span>
      </div>
      <textarea
        defaultValue={description}
        onBlur={(e) => { if (e.target.value !== description) edit.mutate({ description: e.target.value }); }}
        rows={2}
        aria-label={`descripción de ${label}`}
      />
      {edit.isError && <Failed error={edit.error} />}
    </li>
  );
}
