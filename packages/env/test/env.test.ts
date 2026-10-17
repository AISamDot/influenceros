import { describe, expect, it } from 'vitest';
import { DEFAULT_STUDIO_DOMAIN, isDeployed, studioDomain, troupeEnv } from '../src';

describe('troupeEnv', () => {
  it('reads TROUPE_<name> first and falls back to the legacy IOS_<name>', () => {
    expect(troupeEnv('AUTH', { TROUPE_AUTH: 'off', IOS_AUTH: 'on' })).toBe('off');
    expect(troupeEnv('AUTH', { IOS_AUTH: 'off' })).toBe('off');
    expect(troupeEnv('AUTH', {})).toBeUndefined();
  });

  it('a blank new value does not hide a set legacy one; both blank returns the blank', () => {
    expect(troupeEnv('WORKER', { TROUPE_WORKER: '', IOS_WORKER: 'inline' })).toBe('inline');
    expect(troupeEnv('WORKER', { TROUPE_WORKER: '  ', IOS_WORKER: '' })).toBe('  ');
    expect(troupeEnv('WORKER', { IOS_WORKER: '' })).toBe('');
  });

  it('accepts prefixed names', () => {
    expect(troupeEnv('TROUPE_FAKE_PROVIDERS', { IOS_FAKE_PROVIDERS: '1' })).toBe('1');
    expect(troupeEnv('IOS_FAKE_PROVIDERS', { TROUPE_FAKE_PROVIDERS: 'zernio' })).toBe('zernio');
  });

  it('defaults to process.env (Vitest sets TROUPE_FAKE_PROVIDERS)', () => {
    expect(troupeEnv('FAKE_PROVIDERS')).toBe('1');
  });

  it('isDeployed honours VERCEL, TROUPE_DEPLOYED and the legacy IOS_DEPLOYED', () => {
    expect(isDeployed({})).toBe(false);
    expect(isDeployed({ VERCEL: '1' })).toBe(true);
    expect(isDeployed({ TROUPE_DEPLOYED: '1' })).toBe(true);
    expect(isDeployed({ IOS_DEPLOYED: '1' })).toBe(true);
  });
});

describe('studioDomain', () => {
  it('is unset locally (sites at /p/<slug>) and troupehouse.com when deployed', () => {
    expect(DEFAULT_STUDIO_DOMAIN).toBe('troupehouse.com');
    expect(studioDomain({})).toBeNull();
    expect(studioDomain({ VERCEL: '1' })).toBe('troupehouse.com');
    expect(studioDomain({ TROUPE_DEPLOYED: '1' })).toBe('troupehouse.com');
  });

  it('the configured domain wins (new or legacy name), normalised; "off" disables persona hosts', () => {
    expect(studioDomain({ TROUPE_STUDIO_DOMAIN: ' .Studio.Example. ' })).toBe('studio.example');
    expect(studioDomain({ IOS_STUDIO_DOMAIN: 'legacy.example' })).toBe('legacy.example');
    expect(studioDomain({ TROUPE_STUDIO_DOMAIN: 'new.example', IOS_STUDIO_DOMAIN: 'legacy.example', VERCEL: '1' })).toBe('new.example');
    expect(studioDomain({ TROUPE_STUDIO_DOMAIN: 'off', VERCEL: '1' })).toBeNull();
  });
});
