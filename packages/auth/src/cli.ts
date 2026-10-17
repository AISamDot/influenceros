// `pnpm owner <command>`: Owner account commands. Input is hidden; nothing secret is printed except the one-time
// sign-in link `login-link` exists to print (on the Owner's own machine).
import { troupeEnv } from '@troupe/env';
import { DbLockedError, openDb } from '@troupe/db';
import { migrate } from '@troupe/db/migrate';
import { promptSecret } from '@troupe/secrets';
import { authStatus, issueLoginLink, MAGIC_LINK_TTL_MS, MIN_PASSWORD_LENGTH, revokeAllSessions, setOwnerPassword } from './owner';

const USAGE = `Usage: pnpm owner <command>
  set-password       set (or replace) the fallback sign-in password; signs out every session
  sessions revoke    sign out every session
  login-link         print a one-time sign-in link (recovery when web sign-in is throttled or email is down)
  status             password set?, active sessions, email sign-in configured?`;

/**
 * The dashboard origin links point at: TROUPE_PUBLIC_URL, else http://localhost:<PORT>, else port 3100 (the same rule as
 * `appOrigin()` in @troupe/agents, which this package can't import).
 */
function loginBaseUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return (troupeEnv('PUBLIC_URL', env)?.trim() || `http://localhost:${env.PORT?.trim() || 3100}`).replace(/\/+$/, '');
}

/** What to do instead while another process (normally the dev server) has the local database open. */
function lockedHint(cmd: string, holder: { role: string; origin: string | null }): string {
  const origin = holder.origin ?? (holder.role === 'server' ? loginBaseUrl() : null);
  if (cmd === 'login-link' && origin) return `The server is running, so sign in at ${origin}/login instead (email link or password).`;
  if (cmd === 'set-password' && origin) return `Signed in at ${origin}? Stop the server for a moment, run this, then start it again.`;
  return '';
}

async function main(argv: string[]): Promise<number> {
  const [cmd, sub] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  let db;
  try {
    db = await openDb();
  } catch (err) {
    if (err instanceof DbLockedError) {
      // Another process (the dev server) holds the local PGlite dir: refuse clearly instead of corrupting it.
      const hint = lockedHint(cmd, err.holder);
      const lines = err.message.split('\n');
      if (hint) lines.splice(2, 0, hint);
      console.error(lines.join('\n'));
      return 1;
    }
    console.error(`Couldn't open the database (${(err as Error).message}).`);
    return 1;
  }
  try {
    await migrate(db);
    if (cmd === 'set-password') {
      const a = await promptSecret(`New Owner password (${MIN_PASSWORD_LENGTH}+ characters): `);
      const b = await promptSecret('Repeat it: ');
      if (a !== b) {
        console.error('The two entries differ. Nothing changed.');
        return 1;
      }
      await setOwnerPassword(db, a);
      console.log('Password set. Every existing session was signed out.');
      return 0;
    }
    if (cmd === 'login-link') {
      console.log(await issueLoginLink(db, { baseUrl: loginBaseUrl() }));
      console.log(`Works once, for ${MAGIC_LINK_TTL_MS / 60_000} minutes.`);
      return 0;
    }
    if (cmd === 'sessions' && sub === 'revoke') {
      console.log(`Signed out ${await revokeAllSessions(db)} session(s).`);
      return 0;
    }
    if (cmd === 'status') {
      const s = await authStatus(db);
      console.log(`Password: ${s.passwordSet ? 'set' : 'not set (pnpm owner set-password)'}`);
      console.log(`Active sessions: ${s.activeSessions}`);
      console.log(`Email sign-in: ${process.env.OWNER_EMAIL ? 'OWNER_EMAIL is set' : 'OWNER_EMAIL is not set'}`);
      console.log(`AUTH_SECRET: ${process.env.AUTH_SECRET ? 'set' : 'not set (local secret in .data/auth-secret; required when deployed)'}`);
      return 0;
    }
    console.error(USAGE);
    return 2;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  } finally {
    await db.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
