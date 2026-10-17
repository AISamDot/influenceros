import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  defaultBackend,
  FallbackBackend,
  importFromBrandOs,
  integrationStates,
  KeyringBackend,
  LEGACY_KEYCHAIN_SERVICE,
  MemoryKeyring,
  migrateKeychainService,
  NullBackend,
  readSecret,
  runSecretsCli,
  Secret,
  type CliIo,
} from '../src';

// Never the real Keychain: memory backends only. Values are fake and must never appear in output.
const FAKE_APIFY = 'apify_FAKE_value_123';
const FAKE_ELEVEN = 'eleven_FAKE_value_456';

function io(over: Partial<CliIo> = {}): CliIo & { lines: string[] } {
  const lines: string[] = [];
  return {
    backend: new MemoryKeyring(),
    brandosBackend: new MemoryKeyring(),
    promptSecret: async () => 'sk-ant-FAKE-test-only',
    confirm: async () => true,
    out: (l) => lines.push(l),
    env: {},
    ...over,
    lines,
  };
}

describe('secrets', () => {
  it('never uses the real Keychain under Vitest', () => {
    expect(defaultBackend()).toBeInstanceOf(NullBackend);
  });

  it('KeyringBackend uses service ai.troupe-house and account = secret name', () => {
    const seen: Array<[string, string]> = [];
    const store = new Map<string, string>();
    const mod = {
      Entry: class {
        constructor(
          readonly service: string,
          readonly account: string,
        ) {
          seen.push([service, account]);
        }
        getPassword() {
          return store.get(this.account) ?? null;
        }
        setPassword(v: string) {
          store.set(this.account, v);
        }
        deletePassword() {
          return store.delete(this.account);
        }
      },
    };
    const kb = new KeyringBackend(undefined, mod);
    kb.set('apify.token', FAKE_APIFY);
    expect(kb.get('apify.token')).toBe(FAKE_APIFY);
    expect(seen[0]).toEqual(['ai.troupe-house', 'apify.token']);
  });

  it('the legacy Influencer OS service is ai.influencer-os', () => {
    expect(LEGACY_KEYCHAIN_SERVICE).toBe('ai.influencer-os');
  });

  it('FallbackBackend reads the new service first, then the legacy one; writes and deletes only the new one', () => {
    const current = new MemoryKeyring({ 'anthropic.api_key': 'new-FAKE' });
    const legacy = new MemoryKeyring({ 'anthropic.api_key': 'old-FAKE', 'zernio.api_key': 'zernio-old-FAKE' });
    const kc = new FallbackBackend(current, legacy);
    expect(kc.get('anthropic.api_key')).toBe('new-FAKE');
    expect(kc.get('zernio.api_key')).toBe('zernio-old-FAKE');
    expect(kc.get('resend.api_key')).toBeNull();
    kc.set('resend.api_key', 're-FAKE');
    expect(current.get('resend.api_key')).toBe('re-FAKE');
    expect(legacy.get('resend.api_key')).toBeNull();
    // readSecret / integration status see legacy-only items.
    expect(readSecret('zernio.api_key', kc, {})?.reveal()).toBe('zernio-old-FAKE');
    expect(integrationStates(kc, {}).find((s) => s.def.id === 'zernio')?.status).toBe('connected');
    // delete never touches the legacy service (main and the Desktop checkout still read it).
    expect(kc.delete('zernio.api_key')).toBe(false);
    expect(legacy.get('zernio.api_key')).toBe('zernio-old-FAKE');
    expect(kc.delete('anthropic.api_key')).toBe(true);
    expect(current.get('anthropic.api_key')).toBeNull();
    expect(legacy.get('anthropic.api_key')).toBe('old-FAKE');
    expect(kc.get('anthropic.api_key')).toBe('old-FAKE');
    expect(JSON.stringify({ kc })).not.toContain('FAKE');
    expect(inspect(kc)).not.toContain('FAKE');
  });

  it('migrateKeychainService copies every known secret once, never overwrites, keeps the old items, returns no values', () => {
    const legacy = new MemoryKeyring({
      'supabase.database_url': 'postgres://FAKE',
      'supabase.service_role_key': 'sb_secret_FAKE',
      'anthropic.api_key': 'sk-ant-FAKE-old',
      'zernio.api_key': 'zernio-FAKE',
      'not.a.secret': 'ignored-FAKE',
    });
    const current = new MemoryKeyring({ 'anthropic.api_key': 'sk-ant-FAKE-new' });
    const first = migrateKeychainService(legacy, current);
    expect(first.counts).toMatchObject({ copied: 3, already_set: 1, unreadable: 0, failed: 0 });
    expect(first.counts.missing).toBe(first.results.length - 4);
    expect(current.get('supabase.database_url')).toBe('postgres://FAKE');
    expect(current.get('zernio.api_key')).toBe('zernio-FAKE');
    expect(current.get('anthropic.api_key')).toBe('sk-ant-FAKE-new');
    expect(current.get('not.a.secret')).toBeNull();
    expect(legacy.get('supabase.database_url')).toBe('postgres://FAKE');
    expect(JSON.stringify(first)).not.toContain('FAKE');
    // Idempotent: a second run copies nothing.
    const second = migrateKeychainService(legacy, current);
    expect(second.counts).toMatchObject({ copied: 0, already_set: 4 });
  });

  it('migrateKeychainService reports an unreadable legacy item without failing the rest', () => {
    const legacy = new MemoryKeyring({ 'zernio.api_key': 'zernio-FAKE' });
    const locked = {
      get: (n: string) => {
        if (n === 'apify.token') throw new Error('keychain locked');
        return legacy.get(n);
      },
      set: () => undefined,
      delete: () => false,
    };
    const current = new MemoryKeyring();
    const r = migrateKeychainService(locked, current);
    expect(r.counts).toMatchObject({ copied: 1, unreadable: 1 });
    expect(current.get('zernio.api_key')).toBe('zernio-FAKE');
  });

  it('CLI migrate-service prints counts only and status reads the legacy service', async () => {
    const legacy = new MemoryKeyring({ 'zernio.api_key': 'zernio-FAKE', 'anthropic.api_key': 'sk-ant-FAKE' });
    const t = io({ legacyBackend: legacy });
    expect(await runSecretsCli(['status'], t)).toBe(0);
    expect(t.lines.join('\n')).toMatch(/zernio\.api_key\s+keychain/);
    expect(await runSecretsCli(['migrate-service'], t)).toBe(0);
    expect(await runSecretsCli(['migrate-service'], t)).toBe(0);
    const out = t.lines.join('\n');
    expect(out).not.toContain('FAKE');
    expect(out).toMatch(/Copied 2, already set 0/);
    expect(out).toMatch(/Copied 0, already set 2/);
    expect(t.backend.get('zernio.api_key')).toBe('zernio-FAKE');
    expect(legacy.get('zernio.api_key')).toBe('zernio-FAKE');
    expect(await runSecretsCli(['migrate-service'], io())).toBe(1);
  });

  it('CLI unset removes the new item only, leaves the legacy one and says so without values', async () => {
    const legacy = new MemoryKeyring({ 'zernio.api_key': 'zernio-old-FAKE' });
    const t = io({ legacyBackend: legacy });
    t.backend.set('zernio.api_key', 'zernio-new-FAKE');
    expect(await runSecretsCli(['unset', 'zernio.api_key'], t)).toBe(0);
    expect(t.backend.get('zernio.api_key')).toBeNull();
    expect(legacy.get('zernio.api_key')).toBe('zernio-old-FAKE');
    expect(await runSecretsCli(['unset', 'zernio.api_key'], t)).toBe(0);
    expect(legacy.get('zernio.api_key')).toBe('zernio-old-FAKE');
    const out = t.lines.join('\n');
    expect(out).toMatch(/Removed zernio\.api_key from ai\.troupe-house\./);
    expect(out).toMatch(/zernio\.api_key was not set in ai\.troupe-house\./);
    expect(out).toMatch(/still in the old ai\.influencer-os service/);
    expect(out).not.toContain('FAKE');
  });

  it('Secret values refuse to print', () => {
    const s = new Secret('sk-FAKE');
    expect(String(s)).toBe('[secret]');
    expect(JSON.stringify({ s })).not.toContain('sk-FAKE');
    expect(inspect(s)).not.toContain('sk-FAKE');
  });

  it('reads env first, then the Keychain', () => {
    const kc = new MemoryKeyring({ 'apify.token': FAKE_APIFY });
    expect(readSecret('apify.token', kc, {})?.reveal()).toBe(FAKE_APIFY);
    expect(readSecret('apify.token', kc, { APIFY_TOKEN: 'from-env' })?.reveal()).toBe('from-env');
    expect(readSecret('resend.api_key', kc, {})).toBeNull();
  });

  it('imports Brand OS secrets without exposing values', () => {
    const brandos = new MemoryKeyring({ 'apify.token': FAKE_APIFY, 'elevenlabs.api_key': FAKE_ELEVEN });
    const troupe = new MemoryKeyring({ 'elevenlabs.api_key': 'already-here' });
    const res = importFromBrandOs(brandos, troupe);
    expect(res).toEqual([
      { name: 'apify.token', outcome: 'copied' },
      { name: 'elevenlabs.api_key', outcome: 'already_set' },
      { name: 'pixabay.api_key', outcome: 'missing_in_brandos' },
    ]);
    expect(JSON.stringify(res)).not.toContain('FAKE');
    expect(troupe.get('apify.token')).toBe(FAKE_APIFY);
    expect(troupe.get('elevenlabs.api_key')).toBe('already-here');
  });

  it('CLI: set, status, import and unset never print values', async () => {
    const t = io({ brandosBackend: new MemoryKeyring({ 'apify.token': FAKE_APIFY }) });
    expect(await runSecretsCli(['set', 'anthropic.api_key'], t)).toBe(0);
    expect(t.backend.get('anthropic.api_key')).toBe('sk-ant-FAKE-test-only');
    expect(await runSecretsCli(['import-brandos', '--yes'], t)).toBe(0);
    expect(await runSecretsCli(['status'], t)).toBe(0);
    expect(await runSecretsCli(['unset', 'anthropic.api_key'], t)).toBe(0);
    const out = t.lines.join('\n');
    expect(out).not.toContain('FAKE');
    expect(out).toMatch(/apify\.token: copied/);
    expect(out).toMatch(/anthropic\.api_key\s+keychain/);
    expect(await runSecretsCli(['set', 'not.a.secret'], t)).toBe(2);
  });

  it('CLI import asks y/n per secret', async () => {
    const answers = [true, false, false];
    const t = io({
      brandosBackend: new MemoryKeyring({ 'apify.token': FAKE_APIFY, 'elevenlabs.api_key': FAKE_ELEVEN }),
      confirm: async () => answers.shift() ?? false,
    });
    await runSecretsCli(['import-brandos'], t);
    expect(t.backend.get('apify.token')).toBe(FAKE_APIFY);
    expect(t.backend.get('elevenlabs.api_key')).toBeNull();
  });

  it('integration status: Connected · Pending key · Fake mode, and fake until a live adapter exists', () => {
    const kc = new MemoryKeyring({ 'apify.token': FAKE_APIFY });
    const states = integrationStates(kc, { ANTHROPIC_API_KEY: 'x' });
    const by = Object.fromEntries(states.map((s) => [s.def.id, s]));
    expect(by.apify?.status).toBe('connected');
    expect(by.anthropic?.status).toBe('connected');
    expect(by.resend?.status).toBe('pending_key');
    // Live only where a key is present and a live adapter exists (Anthropic and Resend have one from IOS-2; Apify from
    // IOS-5 stream I, whose contract flips its entry to liveAdapter: true). Open-Meteo needs no key, so it is live
    // unless fakes are forced.
    expect(states.filter((s) => s.mode === 'live').map((s) => s.def.id)).toEqual(['anthropic', 'apify', 'open-meteo']);
    expect(integrationStates(kc, { ANTHROPIC_API_KEY: 'x', TROUPE_FAKE_PROVIDERS: '1' }).every((s) => s.mode === 'fake')).toBe(true);
    expect(integrationStates(kc, { TROUPE_FAKE_PROVIDERS: 'apify' }).find((s) => s.def.id === 'apify')?.status).toBe(
      'fake_mode',
    );
    const ids = states.map((s) => s.def.id);
    for (const id of ['anthropic', 'higgsfield', 'fal', 'elevenlabs', 'zernio', 'lemonsqueezy', 'resend', 'apify', 'pixabay', 'discord', 'vercel', 'supabase']) {
      expect(ids).toContain(id);
    }
  });
});
