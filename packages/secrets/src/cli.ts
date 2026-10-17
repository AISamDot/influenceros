#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { runSecretsCli } from './cli-core';
import { KeyringBackend } from './keyring';
import { promptSecret } from './prompt';
import { BRANDOS_KEYCHAIN_SERVICE, KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE } from './store';

// `pnpm troupe secrets <cmd>`. The first argument is the command group. `pnpm ios …` is a deprecated alias (one release).
if (process.env.npm_lifecycle_event === 'ios') console.error('Note: `pnpm ios` is deprecated; use `pnpm troupe`.');
const [group, ...args] = process.argv.slice(2);
if (group !== 'secrets') {
  console.log('Usage: troupe secrets status|set|unset|import-brandos|migrate-service');
  process.exit(group ? 2 : 0);
}

const code = await runSecretsCli(args, {
  backend: new KeyringBackend(KEYCHAIN_SERVICE),
  legacyBackend: new KeyringBackend(LEGACY_KEYCHAIN_SERVICE),
  brandosBackend: new KeyringBackend(BRANDOS_KEYCHAIN_SERVICE),
  promptSecret: (label) => promptSecret(label),
  async confirm(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return /^y(es)?$/i.test((await rl.question(question)).trim());
    } finally {
      rl.close();
    }
  },
  out: (line) => console.log(line),
});
process.exit(code);
