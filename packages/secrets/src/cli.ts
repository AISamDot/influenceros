#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { runSecretsCli } from './cli-core';
import { KeyringBackend } from './keyring';
import { promptSecret } from './prompt';
import { BRANDOS_KEYCHAIN_SERVICE, KEYCHAIN_SERVICE } from './store';

// `pnpm ios secrets <cmd>`. The first argument is the command group.
const [group, ...args] = process.argv.slice(2);
if (group !== 'secrets') {
  console.log('Usage: ios secrets status|set|unset|import-brandos');
  process.exit(group ? 2 : 0);
}

const code = await runSecretsCli(args, {
  backend: new KeyringBackend(KEYCHAIN_SERVICE),
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
