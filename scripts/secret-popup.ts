/**
 * `pnpm ios:keys` — the non-developer way to store keys: each secret is asked for in a macOS pop-up with hidden
 * input, then saved straight to the Keychain (service ai.influencer-os). The value never touches argv, shell history,
 * the screen or a file; only the secret's name is printed. Usage: tsx scripts/secret-popup.ts <name> [<name>…]
 */
import { execFileSync } from 'node:child_process';
import { KEYCHAIN_SERVICE, KeyringBackend, SECRETS, isSecretName, writeSecret } from '../packages/secrets/src/index';

const HINTS: Partial<Record<string, string>> = {
  'supabase.database_url':
    'Supabase → Connect → Transaction pooler (port 6543). The full link, with your database password in place of [YOUR-PASSWORD].',
  'supabase.service_role_key': 'Supabase → Project Settings → API Keys → Secret key (starts with sb_secret_).',
};

const asAppleScript = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function ask(name: string): string | null {
  const label = SECRETS[name as keyof typeof SECRETS].label;
  const prompt = `Paste your ${label}.\n\n${HINTS[name] ?? ''}\n\nIt is saved to your Mac's Keychain only.`;
  try {
    const out = execFileSync(
      'osascript',
      ['-e', `text returned of (display dialog ${asAppleScript(prompt)} default answer "" with hidden answer with title "Influencer OS keys" buttons {"Cancel", "Save"} default button "Save")`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.replace(/[\r\n]+$/, '');
  } catch {
    return null; // Cancel
  }
}

const names = process.argv.slice(2);
if (!names.length || !names.every(isSecretName)) {
  console.error(`Usage: pnpm ios:keys <secret name>…  (known: ${Object.keys(SECRETS).join(', ')})`);
  process.exit(2);
}
const backend = new KeyringBackend(KEYCHAIN_SERVICE);
let failed = 0;
for (const name of names) {
  const value = ask(name);
  if (value === null || !value.trim()) {
    console.log(`Skipped ${name}.`);
    continue;
  }
  try {
    writeSecret(backend, name, value.trim());
    console.log(`Saved ${name} to the Keychain.`);
  } catch (err) {
    failed++;
    console.log(`Not saved ${name}: ${(err as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
