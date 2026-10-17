import { type SecretBackend, type SecretName, writeSecret } from './store';

/** Brand OS secrets Troupe House can reuse (same names in service `ai.brandos`). */
export const BRANDOS_IMPORTABLE: readonly SecretName[] = ['apify.token', 'elevenlabs.api_key', 'pixabay.api_key'];

export type ImportOutcome = 'copied' | 'missing_in_brandos' | 'already_set' | 'unreadable';

/**
 * Copies named secrets from the Brand OS Keychain service into Troupe House's, without returning or printing the
 * values. Existing Troupe House items are kept unless `overwrite`.
 */
export function importFromBrandOs(
  source: SecretBackend,
  target: SecretBackend,
  names: readonly SecretName[] = BRANDOS_IMPORTABLE,
  opts: { overwrite?: boolean } = {},
): Array<{ name: SecretName; outcome: ImportOutcome }> {
  return names.map((name) => {
    if (!opts.overwrite && target.get(name)) return { name, outcome: 'already_set' as const };
    let value: string | null;
    try {
      value = source.get(name);
    } catch {
      return { name, outcome: 'unreadable' as const };
    }
    if (!value) return { name, outcome: 'missing_in_brandos' as const };
    writeSecret(target, name, value.trim());
    return { name, outcome: 'copied' as const };
  });
}
