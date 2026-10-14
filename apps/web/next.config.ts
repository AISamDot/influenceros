import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const here = dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@ios/core', '@ios/db', '@ios/providers', '@ios/secrets'],
  // Native / WASM packages load their own files at runtime.
  serverExternalPackages: ['@electric-sql/pglite', '@electric-sql/pglite-pgvector', 'pg', '@napi-rs/keyring'],
  outputFileTracingRoot: join(here, '..', '..'),
  turbopack: { root: join(here, '..', '..') },
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
  devIndicators: false,
  agentRules: false,
  // The dashboard is never framed (clickjacking on "Approve kill", kill switches).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
};

export default config;
