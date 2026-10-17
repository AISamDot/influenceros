import { personaSiteUrl } from '@troupe/agents';
import { gatePost } from '@troupe/content';
import { OWNER } from '@troupe/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountSetupSheet, BIO_MAX, INSTAGRAM_LOGIN_WARNING, syncAccounts, updateAccount, upsertAccount } from '../src';
import { type Ctx, persona, setup } from './helpers';

let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => ctx.db.close());

describe('Settings → Accounts', () => {
  it('builds the setup sheet: handle, bio, profile image, link-in-bio and AI-label steps per platform', async () => {
    const p = await persona(ctx, { name: 'Maya Brooks', niche: 'personal finance' });
    await ctx.db.query(`UPDATE persona SET portrait_url = 'https://img/maya.jpg' WHERE id = $1`, [p.id]);
    const sheet = await accountSetupSheet(ctx.db, p.id, ctx.clock.now);
    expect(sheet.rows.map((r) => r.platform)).toEqual(['tiktok', 'instagram', 'youtube']);
    for (const r of sheet.rows) {
      expect(r.suggested).toBe(true);
      expect(r.handle).toMatch(/^maya\.?personal$/);
      expect(r.bio.length).toBeLessThanOrEqual(BIO_MAX[r.platform]);
      expect(r.bio).not.toMatch(/\bAI\b/); // no bio line (owner rule)
      expect(r.profileImageUrl).toBe('https://img/maya.jpg');
      expect(r.link).toBe(personaSiteUrl(p.slug));
      expect(r.aiLabelSteps.length).toBeGreaterThan(0);
      expect(r.status).toBe('not created');
    }
    // YouTube waits for day 30.
    expect(sheet.rows.find((r) => r.platform === 'youtube')!.availableFrom).toBeInstanceOf(Date);
    expect(sheet.rows.find((r) => r.platform === 'tiktok')!.availableFrom).toBeNull();
  });

  it('only the Owner records and changes accounts; handles are unique across personas', async () => {
    const a = await persona(ctx);
    const b = await persona(ctx);
    await expect(upsertAccount(ctx.svc, { personaId: a.id, platform: 'tiktok', handle: 'maya.money', actor: { type: 'agent', id: 'persona-manager' } })).rejects.toThrow(/Owner/);
    const id = await upsertAccount(ctx.svc, { personaId: a.id, platform: 'tiktok', handle: '@maya.money', actor: OWNER });
    expect(await upsertAccount(ctx.svc, { personaId: a.id, platform: 'tiktok', handle: 'maya.money2', actor: OWNER })).toBe(id);
    await expect(upsertAccount(ctx.svc, { personaId: b.id, platform: 'tiktok', handle: 'MAYA.MONEY2', actor: OWNER })).rejects.toThrow(/already/);
    await expect(upsertAccount(ctx.svc, { personaId: a.id, platform: 'tiktok', handle: 'bad handle!', actor: OWNER })).rejects.toThrow(/handle/);
    await updateAccount(ctx.svc, { accountId: id, actor: OWNER, status: 'active', aiLabelOk: true, vendorRef: 'acc_1' });
    const row = await ctx.db.one<{ status: string; ai_label_ok: boolean; token_ref: string; meta: Record<string, unknown> }>('SELECT status, ai_label_ok, token_ref, meta FROM account WHERE id = $1', [id]);
    expect(row).toMatchObject({ status: 'active', ai_label_ok: true, token_ref: 'acc_1', meta: { ai_label_source: 'owner' } });
    const sheet = await accountSetupSheet(ctx.db, a.id, ctx.clock.now);
    expect(sheet.rows[0]).toMatchObject({ handle: 'maya.money2', suggested: false, status: 'active', aiLabelOk: true, linked: true });
    const audit = await ctx.db.query<{ action: string }>(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id`, [id]);
    expect(audit.map((x) => x.action)).toEqual(['account.created', 'account.updated', 'account.updated']);
  });

  it('accounts.sync links vendor accounts by handle, activates them and reads the AI profile label', async () => {
    const p = await persona(ctx);
    const id = await upsertAccount(ctx.svc, { personaId: p.id, platform: 'instagram', handle: 'maya.money', actor: OWNER });
    ctx.providers.publish.accounts.push(
      { accountRef: 'zr_ig_1', platform: 'instagram', handle: 'Maya.Money', aiProfileLabel: true },
      { accountRef: 'zr_tt_2', platform: 'tiktok', handle: 'someone.else', aiProfileLabel: null },
    );
    const res = await syncAccounts(ctx.svc);
    expect(res.linked).toEqual([id]);
    expect(res.labelUpdated).toEqual([id]);
    expect(res.unmatched).toEqual([{ platform: 'tiktok', handle: 'someone.else', accountRef: 'zr_tt_2' }]);
    const row = await ctx.db.one<{ status: string; ai_label_ok: boolean; token_ref: string }>('SELECT status, ai_label_ok, token_ref FROM account WHERE id = $1', [id]);
    expect(row).toEqual({ status: 'active', ai_label_ok: true, token_ref: 'zr_ig_1' });
    // Idempotent.
    expect((await syncAccounts(ctx.svc)).linked).toEqual([]);
  });

  it('warns on Settings → Accounts when Instagram is connected in Zernio without Facebook Login, and clears it once fixed', async () => {
    const p = await persona(ctx);
    const id = await upsertAccount(ctx.svc, { personaId: p.id, platform: 'instagram', handle: 'maya.money', actor: OWNER });
    ctx.providers.publish.accounts.push({ accountRef: 'zr_ig_1', platform: 'instagram', handle: 'maya.money', aiProfileLabel: null, loginMethod: 'instagram_login' });
    const res = await syncAccounts(ctx.svc);
    expect(res.linked).toEqual([id]);
    expect(res.warnings).toEqual([{ accountId: id, platform: 'instagram', handle: 'maya.money', warning: INSTAGRAM_LOGIN_WARNING }]);
    const ig = (await accountSetupSheet(ctx.db, p.id, ctx.clock.now)).rows.find((r) => r.platform === 'instagram')!;
    expect(ig.warning).toMatch(/Facebook Login/);
    expect(ig.aiLabelSteps.join(' ')).toMatch(/Facebook Login option/);
    // The Owner reconnects with Facebook Login: the next sync records it and the warning goes.
    ctx.providers.publish.accounts.splice(0, 1, { accountRef: 'zr_ig_1', platform: 'instagram', handle: 'maya.money', aiProfileLabel: null, loginMethod: 'facebook_login' });
    expect((await syncAccounts(ctx.svc)).warnings).toEqual([]);
    expect((await accountSetupSheet(ctx.db, p.id, ctx.clock.now)).rows.find((r) => r.platform === 'instagram')!.warning).toBeNull();
    expect((await ctx.db.one<{ meta: Record<string, unknown> }>('SELECT meta FROM account WHERE id = $1', [id])).meta.login_method).toBe('facebook_login');
  });

  it('the Gate ambers a post whose account has no platform AI profile label', async () => {
    const p = await persona(ctx);
    const id = await upsertAccount(ctx.svc, { personaId: p.id, platform: 'tiktok', handle: 'maya.nolabel', actor: OWNER });
    await updateAccount(ctx.svc, { accountId: id, actor: OWNER, status: 'active' });
    const post = await ctx.db.one<{ id: string }>(`INSERT INTO post (persona_id, account_id, platform, format, caption, status) VALUES ($1, $2, 'tiktok', 'talking', 'Save more this week.', 'draft') RETURNING id`, [p.id, id]);
    expect((await gatePost(ctx.svc, post.id)).verdict).toBe('amber');
    await updateAccount(ctx.svc, { accountId: id, actor: OWNER, aiLabelOk: true });
    expect((await gatePost(ctx.svc, post.id)).verdict).toBe('green');
  });
});

describe('bios', () => {
  it("uses the bible's bio and fits it to each platform by whole sentences, keeping the CTA", async () => {
    const { bibleBio, fitBio } = await import('../src/accounts');
    const content = { identity: '| **Bio (all platforms)** | `81. Brooklyn widow, dating again. I retype your texts like a court transcript and rule on them. Comment READ for my free text check ↓` |' };
    const bio = bibleBio(content)!;
    expect(bio).toMatch(/^81\. Brooklyn widow/);
    expect(fitBio(bio, 150)).toBe(bio);
    const short = fitBio(bio, 80);
    expect(short.length).toBeLessThanOrEqual(80);
    expect(short).toMatch(/Comment READ/);
  });
});

describe('bios from structured bibles', () => {
  it('reads a "Bio (…)" key', async () => {
    const { bibleBio } = await import('../src/accounts');
    expect(bibleBio({ identity: { 'Bio (all platforms)': 'Brooklyn widow, dating again. Comment READ ↓' } })).toBe('Brooklyn widow, dating again. Comment READ ↓');
  });
});
