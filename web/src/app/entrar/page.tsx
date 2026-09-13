'use client';
import { Suspense, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEnter } from '@/features/session/queries';
import { Failed, Spinner } from '@/shared/ui/primitives';

/**
 * The link `dm pair --web` prints.
 *
 * The point of a link over a code to copy is that it costs one click, so this
 * redeems it on arrival and gets out of the way. Typing the code by hand still
 * works — the home screen asks for one — but that is the fallback, not the path.
 */
function Enter() {
  const code = useSearchParams().get('code');
  const router = useRouter();
  const enter = useEnter();
  // A pairing code is single-use, so firing twice burns it: the second call
  // fails and the person sees an error for a login that actually worked.
  // React runs effects twice in development, which is exactly how that shows up.
  const fired = useRef(false);

  useEffect(() => {
    if (!code || fired.current) return;
    fired.current = true;
    enter.mutate(code.trim().toUpperCase(), {
      // replace and not push: the code is spent, and leaving it in history means
      // Back lands on a link that can only fail from here on.
      onSuccess: () => router.replace('/'),
    });
  }, [code, enter, router]);

  if (!code) {
    return (
      <main className="center">
        <p className="muted">
          Ese link no trae código. Pide uno con <code>dm pair --web</code>.
        </p>
      </main>
    );
  }

  return (
    <main className="center">
      {enter.isError
        ? <Failed error={enter.error} onRetry={() => router.replace('/')} />
        : <Spinner label="entrando…" />}
    </main>
  );
}

export default function Page() {
  // useSearchParams needs a boundary, and a spinner is the honest thing to show
  // while the only work left is reading a query string.
  return <Suspense fallback={<main className="center"><Spinner /></main>}><Enter /></Suspense>;
}
