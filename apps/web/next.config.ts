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
};

export default config;
