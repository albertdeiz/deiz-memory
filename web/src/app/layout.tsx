import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { QueryProvider } from '@/shared/ui/QueryProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'deiz-memory',
  description: 'Administrar lo guardado. Capturar sigue siendo por chat.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
