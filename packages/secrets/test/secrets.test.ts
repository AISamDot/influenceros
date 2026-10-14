import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  defaultBackend,
  importFromBrandOs,
  integrationStates,
  KeyringBackend,
  MemoryKeyring,
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

  it('KeyringBackend uses service ai.influencer-os and account = secret name', () => {
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
    expect(seen[0]).toEqual(['ai.influencer-os', 'apify.token']);
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
    const ios = new MemoryKeyring({ 'elevenlabs.api_key': 'already-here' });
    const res = importFromBrandOs(brandos, ios);
    expect(res).toEqual([
      { name: 'apify.token', outcome: 'copied' },
      { name: 'elevenlabs.api_key', outcome: 'already_set' },
      { name: 'pixabay.api_key', outcome: 'missing_in_brandos' },
    ]);
    expect(JSON.stringify(res)).not.toContain('FAKE');
    expect(ios.get('apify.token')).toBe(FAKE_APIFY);
    expect(ios.get('elevenlabs.api_key')).toBe('already-here');
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
    // Live only where a key is present and a live adapter exists (Anthropic and Resend have one from IOS-2).
    expect(states.filter((s) => s.mode === 'live').map((s) => s.def.id)).toEqual(['anthropic']);
    expect(integrationStates(kc, { ANTHROPIC_API_KEY: 'x', IOS_FAKE_PROVIDERS: '1' }).every((s) => s.mode === 'fake')).toBe(true);
    expect(integrationStates(kc, { IOS_FAKE_PROVIDERS: 'apify' }).find((s) => s.def.id === 'apify')?.status).toBe(
      'fake_mode',
    );
    const ids = states.map((s) => s.def.id);
    for (const id of ['anthropic', 'higgsfield', 'fal', 'elevenlabs', 'zernio', 'lemonsqueezy', 'resend', 'apify', 'pixabay', 'discord', 'vercel', 'supabase']) {
      expect(ids).toContain(id);
    }
  });
});
