import { OWNER } from '@troupe/core';
import { syncAccounts, updateAccount, upsertAccount } from '@troupe/distribution';
import type { Platform } from '@troupe/providers';
import { requireOwner } from '@/lib/auth';
import { backTo, isFormPost, isJson, UUID_RE } from '@/lib/http';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

const PLATFORMS = ['tiktok', 'instagram', 'youtube'];
const STATUSES = ['pending', 'active', 'paused', 'retired'] as const;

/**
 * Settings → Accounts actions (Owner only), as JSON or a form:
 *   {action: "add", personaId, platform, handle}            record an account the Owner created on the platform
 *   {action: "update", accountId, status?, aiLabel?, vendorRef?}  status, platform AI profile label, Zernio account id
 *   {action: "sync"}                                        link accounts connected in Zernio
 */
export async function POST(req: Request) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const isForm = isFormPost(req);
  if (!isForm && !isJson(req)) return Response.json({ error: 'send JSON or a form' }, { status: 415 });
  const input: Record<string, string> = isForm
    ? Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, String(v)]))
    : ((await req.json().catch(() => ({}))) as Record<string, string>);
  const done = (ok: string, data: Record<string, unknown> = {}) => (isForm ? backTo(req, '/settings/accounts', { ok }) : Response.json({ ok, ...data }));
  const fail = (error: string) => (isForm ? backTo(req, '/settings/accounts', { error }) : Response.json({ error }, { status: 400 }));
  const services = await getServices();
  try {
    switch (input.action) {
      case 'add': {
        if (!UUID_RE.test(input.personaId ?? '')) return fail('choose a persona');
        if (!PLATFORMS.includes(input.platform ?? '')) return fail('choose a platform');
        const id = await upsertAccount(services, { personaId: input.personaId!, platform: input.platform as Platform, handle: input.handle ?? '', actor: OWNER });
        return done('account saved', { accountId: id });
      }
      case 'update': {
        if (!UUID_RE.test(input.accountId ?? '')) return fail('unknown account');
        const status = STATUSES.find((s) => s === input.status);
        const aiLabel = input.aiLabel === 'on' || input.aiLabel === 'true' ? true : input.aiLabel === 'off' || input.aiLabel === 'false' ? false : undefined;
        const vendorRef = input.vendorRef === undefined ? undefined : input.vendorRef.trim() || null;
        await updateAccount(services, { accountId: input.accountId!, actor: OWNER, status, aiLabelOk: aiLabel, vendorRef });
        return done('account updated');
      }
      case 'sync': {
        const r = await syncAccounts(services);
        const warn = r.warnings.length ? `; ${r.warnings.length} Instagram account${r.warnings.length === 1 ? '' : 's'} need${r.warnings.length === 1 ? 's' : ''} Facebook Login in Zernio` : '';
        return done(`synced: ${r.linked.length} linked, ${r.unmatched.length} unmatched in Zernio${warn}`, { ...r });
      }
      default:
        return fail('unknown action');
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message.slice(0, 200) : 'failed');
  }
}
