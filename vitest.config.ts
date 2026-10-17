import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The web app's `@/…` path alias (apps/web/tsconfig.json), so route handlers can be imported in tests.
  resolve: { alias: [{ find: /^@\//, replacement: fileURLToPath(new URL('./apps/web/', import.meta.url)) }] },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Safety net: tests never reach a live provider, even when a key is in the shell environment.
    env: { TROUPE_FAKE_PROVIDERS: '1', TROUPE_KEYCHAIN: 'off' },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
