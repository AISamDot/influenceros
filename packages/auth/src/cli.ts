// `pnpm owner <command>`: Owner account commands. Input is hidden; nothing secret is printed.
import { openDb } from '@ios/db';
import { migrate } from '@ios/db/migrate';
import { promptSecret } from '@ios/secrets';
import { authStatus, MIN_PASSWORD_LENGTH, revokeAllSessions, setOwnerPassword } from './owner';

const USAGE = `Usage: pnpm owner <command>
  set-password       set (or replace) the fallback sign-in password; signs out every session
  sessions revoke    sign out every session
  status             password set?, active sessions, email sign-in configured?`;

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
    console.error(`Couldn't open the database (${(err as Error).message}). With local PGlite, stop \`pnpm dev\` first.`);
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
