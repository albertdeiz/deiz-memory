'use client';
import { useState } from 'react';
import { useEnter, useSession } from './queries';
import { Failed, Spinner } from '@/shared/ui/primitives';
import type { ReactNode } from 'react';

/**
 * Nothing renders until there is a session.
 *
 * A gate and not a redirect: the API already refuses every data route without a
 * cookie, so this is about not painting a shell full of failed requests. The
 * server is the authority; this is courtesy.
 */
export function Gate({ children }: { children: ReactNode }) {
  const session = useSession();

  if (session.isLoading) return <main className="center"><Spinner /></main>;
  if (session.isError) {
    return <main className="center"><Failed error={session.error} onRetry={() => session.refetch()} /></main>;
  }
  if (!session.data?.authenticated) return <Enter />;
  return <>{children}</>;
}

/**
 * The whole login: eight characters, minted by `dm pair --web`.
 *
 * No email, no password, no recovery flow — §10 says the identity comes from a
 * single-use code and this reuses it whole. What it costs is that you need a
 * terminal to get in, which for a tool that listens on 127.0.0.1 is not a cost.
 */
function Enter() {
  const [code, setCode] = useState('');
  const enter = useEnter();

  return (
    <main className="center">
      <form
        className="enter"
        onSubmit={(e) => { e.preventDefault(); enter.mutate(code.trim().toUpperCase()); }}
      >
        <h1>deiz-memory</h1>
        <p className="muted">
          Pide un código con <code>dm pair --web</code> y pégalo acá.
        </p>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="ABCD2345"
          autoFocus
          spellCheck={false}
          maxLength={8}
          aria-label="código de emparejamiento"
        />
        <button type="submit" disabled={code.trim().length < 8 || enter.isPending}>
          {enter.isPending ? 'entrando…' : 'entrar'}
        </button>
        {enter.isError && <Failed error={enter.error} />}
      </form>
    </main>
  );
}
