import { SECRETS, type SecretBackend, type SecretName, writeSecret } from './store';

export type MigrateOutcome = 'copied' | 'already_set' | 'missing' | 'unreadable' | 'failed';

export interface MigrateServiceResult {
  readonly results: ReadonlyArray<{ name: SecretName; outcome: MigrateOutcome }>;
  readonly counts: Readonly<Record<MigrateOutcome, number>>;
}

/**
 * One-time, idempotent copy of every known secret from the legacy Influencer OS Keychain service (`ai.influencer-os`)
 * into the Troupe House one (`ai.troupe-house`). An item already present in the new service is never overwritten,
 * nothing is deleted from the old service, and no value is returned or printed: only names and outcomes.
 */
export function migrateKeychainService(
  legacy: SecretBackend,
  current: SecretBackend,
  names: readonly SecretName[] = Object.keys(SECRETS) as SecretName[],
): MigrateServiceResult {
  const results = names.map((name) => {
    let existing: string | null;
    try {
      existing = current.get(name);
    } catch {
      return { name, outcome: 'unreadable' as const };
    }
    if (existing) return { name, outcome: 'already_set' as const };
    let value: string | null;
    try {
      value = legacy.get(name);
    } catch {
      return { name, outcome: 'unreadable' as const };
    }
    if (!value || !value.trim()) return { name, outcome: 'missing' as const };
    try {
      writeSecret(current, name, value.trim());
    } catch {
      return { name, outcome: 'failed' as const };
    }
    return { name, outcome: 'copied' as const };
  });
  const counts: Record<MigrateOutcome, number> = { copied: 0, already_set: 0, missing: 0, unreadable: 0, failed: 0 };
  for (const r of results) counts[r.outcome]++;
  return { results, counts };
}
