import { BRANDOS_IMPORTABLE, importFromBrandOs } from './brandos-import';
import { integrationStates } from './integrations';
import { isSecretName, SECRETS, type SecretBackend, type SecretName, secretSource, writeSecret } from './store';

export interface CliIo {
  readonly backend: SecretBackend;
  readonly brandosBackend: SecretBackend;
  /** No-echo prompt for a value. */
  promptSecret(label: string): Promise<string>;
  /** y/n question. */
  confirm(question: string): Promise<boolean>;
  out(line: string): void;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const USAGE = `Usage:
  ios secrets status
  ios secrets set <name>          (value is read with hidden input, never from argv)
  ios secrets unset <name>
  ios secrets import-brandos [--yes] [--overwrite] [name…]
Names: ${Object.keys(SECRETS).join(', ')}`;

function nameArg(arg: string | undefined, io: CliIo): SecretName | null {
  if (!arg || !isSecretName(arg)) {
    io.out(arg ? `Unknown secret name: ${arg}` : 'Missing secret name.');
    io.out(USAGE);
    return null;
  }
  return arg;
}

/** `ios secrets …`. Output carries names and statuses only, never a value. Returns the exit code. */
export async function runSecretsCli(args: readonly string[], io: CliIo): Promise<number> {
  const [cmd, ...rest] = args;
  const env = io.env ?? process.env;
  switch (cmd) {
    case 'status': {
      io.out('Secret                         Where        Env var');
      for (const name of Object.keys(SECRETS) as SecretName[]) {
        const src = secretSource(name, io.backend, env);
        io.out(`${name.padEnd(30)} ${(src ?? '—').padEnd(12)} ${SECRETS[name].env}`);
      }
      io.out('');
      io.out('Integration      Status       Runs on');
      for (const s of integrationStates(io.backend, env)) {
        io.out(`${s.def.name.padEnd(16)} ${s.status.padEnd(12)} ${s.mode}`);
      }
      return 0;
    }
    case 'set': {
      const name = nameArg(rest[0], io);
      if (!name) return 2;
      const value = await io.promptSecret(`${SECRETS[name].label} (${name}), input hidden: `);
      try {
        writeSecret(io.backend, name, value);
      } catch (err) {
        io.out(`Not saved: ${(err as Error).message}`);
        return 1;
      }
      io.out(`Saved ${name} to the Keychain.`);
      return 0;
    }
    case 'unset': {
      const name = nameArg(rest[0], io);
      if (!name) return 2;
      io.out(io.backend.delete(name) ? `Removed ${name}.` : `${name} was not set.`);
      return 0;
    }
    case 'import-brandos': {
      const yes = rest.includes('--yes');
      const overwrite = rest.includes('--overwrite');
      const requested = rest.filter((a) => !a.startsWith('--'));
      for (const r of requested) if (!isSecretName(r)) return (io.out(`Unknown secret name: ${r}`), 2);
      const candidates = (requested.length ? requested : BRANDOS_IMPORTABLE) as SecretName[];
      const chosen: SecretName[] = [];
      for (const name of candidates) {
        if (yes || (await io.confirm(`Copy ${name} from Brand OS? (y/n) `))) chosen.push(name);
      }
      const results = importFromBrandOs(io.brandosBackend, io.backend, chosen, { overwrite });
      for (const r of results) io.out(`${r.name}: ${r.outcome.replaceAll('_', ' ')}`);
      if (results.length === 0) io.out('Nothing copied.');
      return 0;
    }
    default:
      io.out(USAGE);
      return cmd ? 2 : 0;
  }
}
