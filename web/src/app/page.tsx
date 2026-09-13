'use client';
import { useState } from 'react';
import { Gate } from '@/features/session/Gate';
import { useLeave } from '@/features/session/queries';
import { MemoryList } from '@/features/memories/MemoryList';
import { MemoryDetail } from '@/features/memories/MemoryDetail';
import { DomainAdmin } from '@/features/domains/DomainAdmin';
import { FactAdmin } from '@/features/facts/FactAdmin';
import { Overview } from '@/features/review/Overview';

type Tab = 'estado' | 'memorias' | 'categorias' | 'datos';

const TABS: { id: Tab; label: string }[] = [
  { id: 'estado', label: 'Estado' },
  { id: 'memorias', label: 'Memorias' },
  { id: 'categorias', label: 'Categorías' },
  { id: 'datos', label: 'Datos duros' },
];

/**
 * One page with tabs, and no router.
 *
 * A tool one person opens to fix something does not need deep links; adding
 * routes would be building for a use that does not exist. The detail is a panel
 * beside the list rather than a page, because curating is comparing.
 */
export default function Home() {
  const [tab, setTab] = useState<Tab>('estado');
  const [open, setOpen] = useState<string | null>(null);
  const leave = useLeave();

  return (
    <Gate>
      <div className="shell">
        <nav>
          <span className="brand">deiz-memory</span>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
          <span className="grow" />
          {/* Cierra TODAS las sesiones, que es lo que "perdí el computador"
              necesita, y lo dice el texto para que no sorprenda. */}
          <button onClick={() => leave.mutate()} title="cierra todas las sesiones">
            salir
          </button>
        </nav>

        <main className={open ? 'split' : ''}>
          <div className="col">
            {tab === 'estado' && <Overview onOpen={setOpen} />}
            {tab === 'memorias' && <MemoryList onOpen={setOpen} />}
            {tab === 'categorias' && <DomainAdmin />}
            {tab === 'datos' && <FactAdmin />}
          </div>
          {open && (
            <div className="col detail">
              <MemoryDetail id={open} onClose={() => setOpen(null)} />
            </div>
          )}
        </main>

        <footer className="muted">
          Para guardar algo, mándalo por el chat. Acá no se captura, a propósito.
        </footer>
      </div>
    </Gate>
  );
}
