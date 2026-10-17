import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const here = dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    '@troupe/agents',
    '@troupe/auth',
    '@troupe/commerce',
    '@troupe/content',
    '@troupe/core',
    '@troupe/db',
    '@troupe/distribution',
    '@troupe/env',
    '@troupe/formats',
    '@troupe/generator',
    '@troupe/knowledge',
    '@troupe/media',
    '@troupe/production',
    '@troupe/products',
    '@troupe/profit',
    '@troupe/providers',
    '@troupe/radar',
    '@troupe/secrets',
    '@troupe/wiring',
    '@troupe/world',
  ],
  // Native / WASM packages load their own files at runtime.
  serverExternalPackages: [
    '@electric-sql/pglite',
    '@electric-sql/pglite-pgvector',
    'pg',
    '@napi-rs/keyring',
    // >>> stream A server externals (append only)
    '@anthropic-ai/claude-agent-sdk',
    // <<< stream A server externals
    // >>> stream B server externals
    // <<< stream B server externals
    // >>> stream C server externals
    '@huggingface/transformers',
    'onnxruntime-node',
    // <<< stream C server externals
    // >>> stream D server externals
    // <<< stream D server externals
    // >>> stream E server externals
    'sharp',
    'ffmpeg-static',
    'ffprobe-static',
    // <<< stream E server externals
    // >>> stream F server externals
    // <<< stream F server externals
    // >>> stream G server externals
    // <<< stream G server externals
    // >>> stream H server externals
    // <<< stream H server externals
    // >>> stream I server externals
    // <<< stream I server externals
    // >>> stream J server externals
    // <<< stream J server externals
    // >>> stream K server externals
    // <<< stream K server externals
    // >>> stream L server externals
    // <<< stream L server externals
  ],
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
