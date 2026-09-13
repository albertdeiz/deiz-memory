import type { NextConfig } from 'next';

/**
 * The web is a pure client of `dm api` (§15). It never touches Postgres, S3 or
 * the model: everything it knows it learned over HTTP from the core, which is
 * what keeps the owner filter in one codebase instead of two.
 *
 * The proxy to that process is a route handler and NOT a rewrite: rewrites are
 * resolved at build time and would bake the destination into the image. See
 * src/app/api/[...path]/route.ts.
 */
const config: NextConfig = {
  // A self-contained server plus only the dependencies it actually reaches, so
  // the runtime image carries no node_modules and no toolchain.
  output: 'standalone',
};

export default config;
