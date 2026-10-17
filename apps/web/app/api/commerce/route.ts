import { enqueueOnceFor } from '@troupe/agents';
import { JOB, linkStore, productSweep, setCheckoutUrl, syncStores, updateCommerceSettings } from '@troupe/commerce';
import { OWNER } from '@troupe/core';
import { requireOwner } from '@/lib/auth';
import { backTo, UUID_RE } from '@/lib/http';
import { studioContext } from '@/lib/server';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

/**
 * Owner actions on /commerce (form posts): settings (physical address, sender domain), checkout URL per product,
 * link a store to a persona, sync stores and products now, (re)write a persona's welcome sequence.
 */
export async function POST(req: Request) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const fd = await req.formData().catch(() => null);
  const f = fd ? Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)])) : {};
  const { db, studio } = await studioContext();
  const services = await getServices();
  const fail = (error: string) => backTo(req, '/commerce', { error });
  const owned = async (table: 'persona' | 'product', id: string | undefined) => {
    if (!id || !UUID_RE.test(id)) return false;
    const sql = table === 'persona' ? 'SELECT 1 FROM persona WHERE id = $1 AND studio_id = $2' : 'SELECT 1 FROM product pr JOIN persona p ON p.id = pr.persona_id WHERE pr.id = $1 AND p.studio_id = $2';
    return Boolean(await db.maybeOne(sql, [id, studio.id]));
  };
  try {
    switch (f.action) {
      case 'settings':
        await updateCommerceSettings(db, studio.id, { physicalAddress: f.physical_address ?? null, senderDomain: f.sender_domain ?? null });
        return backTo(req, '/commerce', { ok: 'Settings saved' });
      case 'checkout_url':
        if (!(await owned('product', f.product_id))) return fail('unknown product');
        await setCheckoutUrl(services, { productId: f.product_id!, url: f.url?.trim() || null, actor: OWNER });
        return backTo(req, '/commerce', { ok: f.url?.trim() ? 'Checkout URL saved' : 'Checkout URL removed' });
      case 'link_store':
        if (!(await owned('persona', f.persona_id))) return fail('unknown persona');
        await linkStore(services, { personaId: f.persona_id!, storeId: f.store_id?.trim() || null, actor: OWNER });
        return backTo(req, '/commerce', { ok: 'Store link saved' });
      case 'sync': {
        const s = await syncStores(services, studio.id);
        const changes = await productSweep(services, { studioId: studio.id });
        return backTo(req, '/commerce', { ok: `${s.linked} of ${s.stores} stores linked · ${changes.length} products updated` });
      }
      case 'write_welcome':
        if (!(await owned('persona', f.persona_id))) return fail('unknown persona');
        await enqueueOnceFor(db, { kind: JOB.writeWelcome, key: `welcome:${f.persona_id}`, payload: { personaId: f.persona_id }, studioId: studio.id, personaId: f.persona_id });
        return backTo(req, '/commerce', { ok: 'The Email Writer is on it' });
      default:
        return fail('unknown action');
    }
  } catch (err) {
    return fail((err as Error).message.slice(0, 160));
  }
}
