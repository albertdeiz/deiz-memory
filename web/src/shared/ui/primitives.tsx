'use client';
import type { ReactNode } from 'react';

/**
 * The handful of pieces every screen needs.
 *
 * Not a design system: a design system for one person's admin tool is work that
 * buys nothing. These exist because the same four states — loading, empty,
 * failed, needs-confirming — otherwise get re-invented on each screen and drift.
 */

export function Panel({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      {(title || action) && (
        <header className="panel-head">
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export const Spinner = ({ label = 'cargando…' }: { label?: string }) => (
  <p className="muted" role="status">{label}</p>
);

export const Empty = ({ children }: { children: ReactNode }) => (
  <p className="muted empty">{children}</p>
);

/**
 * A failure, said in the words the core used.
 *
 * The message comes from the core and is not rewritten here: the CLI and the
 * chat show the same sentence, and three channels paraphrasing one error is how
 * they start contradicting each other.
 */
export function Failed({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Algo falló.';
  return (
    <div className="failed" role="alert">
      <span>{message}</span>
      {onRetry && <button onClick={onRetry}>reintentar</button>}
    </div>
  );
}

/**
 * The dialog a `requires_confirmation` turns into.
 *
 * It names what would be affected rather than counting it: "3 elementos" tells
 * you nothing, and this is the last screen before something irreversible.
 */
export function Confirm({
  message, affects, onCancel, onConfirm, busy,
}: {
  message: string;
  affects: { label?: string; id: string }[];
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="dialog">
        <p>{message}</p>
        {affects.length > 0 && (
          <ul className="affects">
            {affects.map((a) => <li key={a.id}>{a.label ?? a.id}</li>)}
          </ul>
        )}
        <div className="row end">
          <button onClick={onCancel} disabled={busy}>cancelar</button>
          <button className="danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'haciendo…' : 'sí, hazlo'}
          </button>
        </div>
      </div>
    </div>
  );
}

export const Tag = ({ children }: { children: ReactNode }) => <span className="tag">{children}</span>;

/** A date the way the rest of the system writes it: the day, not the instant. */
export const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : '—');
