import type { NextConfig } from 'next';

/**
 * The web is a pure client of `dm api` (§15). It never touches Postgres, S3 or
 * the model: everything it knows it learned over HTTP from the core, which is
 * what keeps the owner filter in one codebase instead of two.
 *
 * So every /api/* call is proxied to that process. In the browser the two are
 * one origin, which is why the session cookie can be SameSite=Strict and no CORS
 * header has to exist anywhere.
 */
const API = process.env.DM_API_URL ?? 'http://127.0.0.1:4317';

const config: NextConfig = {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
};

export default config;
