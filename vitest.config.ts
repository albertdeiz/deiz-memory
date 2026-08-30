import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Los tests de integración y CLI comparten una base: en serie para que
    // el truncate de uno no le borre las filas al otro.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Los tests usan los servicios del stack de siempre. Lo único que se aísla
    // es la base y el bucket, en tests/helpers/env.ts — que es lo único que los
    // tests destruyen.
  },
});
