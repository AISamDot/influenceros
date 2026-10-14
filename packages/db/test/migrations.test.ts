import { afterEach, describe, expect, it } from 'vitest';
import { createPglite, type Db } from '../src/client';
import { loadMigrations, migrate } from '../src/migrate';
import { createTestDb } from '../src/testing';

const EXPECTED_TABLES = [
  'studio', 'persona', 'persona_bible', 'persona_state_log', 'account',
  'playbook_rule', 'feedback', 'decision', 'plan', 'calendar_slot',
  'idea', 'script', 'asset', 'gate_result', 'qc_report', 'qc_defect', 'qc_standard', 'post', 'metric_snapshot',
  'comment', 'dm_thread', 'escalation',
  'product', 'product_version', 'offer', 'orders', 'refund', 'coupon', 'short_link',
  'subscriber', 'email_sequence', 'email_event',
  'membership', 'community_member', 'community_event',
  'demand_signal', 'product_opportunity', 'validation_test', 'product_brief', 'launch', 'product_readout',
  'product_playbook_rule',
  'budget_allocation', 'credit_ledger', 'experiment', 'kill_scale_proposal',
  'approval', 'agent_run', 'audit_log', 'kill_switch', 'job',
  'chat_thread', 'chat_message', 'notification',
  'knowledge_node', 'knowledge_source', 'news_item', 'news_briefing',
];

let db: Db | null = null;
afterEach(async () => {
  await db?.close();
  db = null;
});

describe('migrations', () => {
  it('apply cleanly on a fresh PGlite and are idempotent', async () => {
    db = await createPglite();
    const applied = await migrate(db);
    expect(applied).toEqual(loadMigrations().map((m) => m.version));
    expect(await migrate(db)).toEqual([]);

    const rows = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tables = new Set(rows.map((r) => r.table_name));
    for (const t of EXPECTED_TABLES) expect(tables, `missing table ${t}`).toContain(t);
  });

  it('gives every persona-scoped table a persona_id column', async () => {
    db = await createTestDb();
    const studioOnly = new Set([
      'studio', 'persona', 'schema_migrations', 'qc_standard', 'product_playbook_rule', 'knowledge_node',
      'knowledge_source', 'news_item',
    ]);
    const cols = await db.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'persona_id'`,
    );
    const withPersona = new Set(cols.map((c) => c.table_name));
    const missing = EXPECTED_TABLES.filter((t) => !studioOnly.has(t) && !withPersona.has(t));
    expect(missing).toEqual([]);
  });

  it('keeps the audit log append-only', async () => {
    db = await createTestDb();
    await db.query(`INSERT INTO audit_log (actor_type, actor_id, action) VALUES ('system','test','x')`);
    await expect(db.query(`UPDATE audit_log SET action = 'y'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
  });

  it('supports pgvector similarity on knowledge nodes', async () => {
    db = await createTestDb();
    const { id: studioId } = await db.one<{ id: string }>(
      `INSERT INTO studio (slug, name) VALUES ('s', 'S') RETURNING id`,
    );
    for (const [path, emb] of [['a', '[1,0,0]'], ['b', '[0,1,0]']] as const) {
      await db.query(
        `INSERT INTO knowledge_node (studio_id, niche, path, title, embedding) VALUES ($1, 'money', $2, $2, $3::vector)`,
        [studioId, path, emb],
      );
    }
    const nearest = await db.one<{ path: string }>(
      `SELECT path FROM knowledge_node ORDER BY embedding <-> '[0.9,0.1,0]'::vector LIMIT 1`,
    );
    expect(nearest.path).toBe('a');
  });
});
