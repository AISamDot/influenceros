import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Safety net: tests never reach a live provider, even when a key is in the shell environment.
    env: { IOS_FAKE_PROVIDERS: '1', IOS_KEYCHAIN: 'off' },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
