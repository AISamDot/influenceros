import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPglite } from '../src/client';
import { acquirePgliteLock, assertPgliteFree, DbLockedError, lockHolder, lockPathFor, processAlive, readLock } from '../src/lock';

const ROOT = resolve(__dirname, '../../..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

const dirs: string[] = [];
const children: ChildProcess[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'ios-lock-'));
  dirs.push(d);
  return join(d, 'pglite');
}
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A live process that isn't us. */
function sleeper(): ChildProcess {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  children.push(c);
  return c;
}

function fakeLock(dir: string, pid: number, extra: Record<string, unknown> = {}): void {
  writeFileSync(lockPathFor(dir), JSON.stringify({ pid, host: hostname(), startedAt: new Date().toISOString(), role: 'server', origin: 'http://localhost:3100', command: 'next dev', ...extra }));
}

describe('PGlite single-process lock', () => {
  it('takes, re-enters and releases the lock in one process', () => {
    const dir = scratch();
    const release1 = acquirePgliteLock(dir, { role: 'cli' });
    expect(readLock(dir)).toMatchObject({ pid: process.pid, role: 'cli' });
    expect(lockHolder(dir)).toBeNull(); // our own lock never blocks us
    const release2 = acquirePgliteLock(dir);
    release1();
    expect(existsSync(lockPathFor(dir))).toBe(true);
    release2();
    release2(); // idempotent
    expect(existsSync(lockPathFor(dir))).toBe(false);
  });

  it('refuses a second process with a clear message naming the holder', () => {
    const dir = scratch();
    const other = sleeper();
    fakeLock(dir, other.pid!);
    expect(processAlive(other.pid!)).toBe(true);
    let err: unknown;
    try {
      acquirePgliteLock(dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DbLockedError);
    const msg = (err as Error).message;
    expect(msg).toContain(`pid ${other.pid}`);
    expect(msg).toContain('the dev server at http://localhost:3100');
    expect(msg).toMatch(/one process per data dir \(two processes corrupt it\)/);
    expect(msg).toContain('DATABASE_URL');
    expect(() => assertPgliteFree(dir)).toThrow(DbLockedError);
  });

  it('createPglite refuses to open a data dir another live process holds', async () => {
    const dir = scratch();
    const other = sleeper();
    fakeLock(dir, other.pid!);
    await expect(createPglite(dir)).rejects.toBeInstanceOf(DbLockedError);
    expect(existsSync(join(dir, 'PG_VERSION'))).toBe(false); // never touched
  });

  it('takes over a stale lock left by a crashed process', async () => {
    const dir = scratch();
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const deadPid = Number(dead.stdout);
    expect(processAlive(deadPid)).toBe(false);
    fakeLock(dir, deadPid);
    expect(lockHolder(dir)).toBeNull();
    const db = await createPglite(dir);
    expect(readLock(dir)?.pid).toBe(process.pid);
    await db.query('SELECT 1');
    await db.close();
    expect(existsSync(lockPathFor(dir))).toBe(false);
  }, 30_000);

  it('exactly one of several processes racing for a stale lock takes it over', async () => {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const deadPid = Number(dead.stdout);
    for (let trial = 0; trial < 3; trial++) {
      const dir = scratch();
      fakeLock(dir, deadPid);
      const script = join(dir, '..', 'racer.mts');
      // Every racer loads first, then all go at the same instant (startAt); each keeps what it got until killed.
      writeFileSync(
        script,
        `import { acquirePgliteLock } from ${JSON.stringify(join(ROOT, 'packages/db/src/lock.ts'))};
const startAt = Number(process.argv[2]);
process.stdout.write('ready\\n');
const idle = startAt - Date.now() - 30;
if (idle > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, idle);
while (Date.now() < startAt) {}
try { acquirePgliteLock(${JSON.stringify(dir)}, { role: 'cli' }); process.stdout.write('ACQUIRED\\n'); }
catch (e) { process.stdout.write((e && e.name === 'DbLockedError' ? 'LOCKED' : 'ERROR ' + e) + '\\n'); }
setInterval(() => {}, 1000);`,
      );
      const startAt = Date.now() + 4_000;
      const results = await Promise.all(
        Array.from({ length: 6 }, () => {
          const c = spawn(process.execPath, ['--import', 'tsx', script, String(startAt)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
          children.push(c);
          return new Promise<string>((res, rej) => {
            let out = '';
            c.stdout!.on('data', (b: Buffer) => {
              out += b.toString();
              const line = out.split('\n').find((l) => /^(ACQUIRED|LOCKED|ERROR)/.test(l));
              if (line) res(line);
            });
            c.once('exit', (code) => rej(new Error(`racer exited ${code}: ${out}`)));
          });
        }),
      );
      expect(results.filter((r) => r === 'ACQUIRED'), results.join(',')).toHaveLength(1);
      expect(results.filter((r) => r === 'LOCKED')).toHaveLength(5);
      for (const c of children.splice(0)) c.kill('SIGKILL');
    }
  }, 90_000);

  it('a real second process is refused while the first has the database open', async () => {
    const dir = scratch();
    const script = join(dir, '..', 'holder.mts');
    writeFileSync(
      script,
      `import { createPglite } from ${JSON.stringify(join(ROOT, 'packages/db/src/client.ts'))};
const db = await createPglite(${JSON.stringify(dir)}, undefined, { role: 'server', origin: 'http://localhost:3100' });
console.log('open');
setTimeout(() => db.close(), 60000);`,
    );
    // One process (node + the tsx loader), so killing it really closes the holder.
    const holder = spawn(process.execPath, ['--import', 'tsx', script], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(holder);
    await new Promise<void>((res, rej) => {
      holder.stdout!.on('data', (b: Buffer) => b.toString().includes('open') && res());
      holder.once('exit', (code) => rej(new Error(`holder exited ${code}`)));
    });
    expect(readLock(dir)).toMatchObject({ role: 'server' });
    await expect(createPglite(dir)).rejects.toThrow(/already open in the dev server at http:\/\/localhost:3100/);
  }, 60_000);
});

describe('CLIs under the lock', () => {
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(TSX, args, {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '', IOS_PUBLIC_URL: '', PORT: '', ...env },
      timeout: 60_000,
    });

  it('`pnpm owner login-link` prints the 3100 origin by default and refuses clearly while the server holds the DB', () => {
    const dir = scratch();
    const ok = run(['packages/auth/src/cli.ts', 'login-link'], { PGLITE_DIR: dir });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/^http:\/\/localhost:3100\/login\/verify\?token=/m);
    expect(existsSync(lockPathFor(dir))).toBe(false); // released on exit

    const withPort = run(['packages/auth/src/cli.ts', 'login-link'], { PGLITE_DIR: dir, PORT: '3201' });
    expect(withPort.stdout).toContain('http://localhost:3201/login/verify?token=');

    const other = sleeper();
    fakeLock(dir, other.pid!);
    const refused = run(['packages/auth/src/cli.ts', 'login-link'], { PGLITE_DIR: dir });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('is already open in the dev server at http://localhost:3100');
    expect(refused.stderr).toContain('sign in at http://localhost:3100/login instead');
    expect(readFileSync(lockPathFor(dir), 'utf8')).toContain(String(other.pid)); // untouched

    const migrate = run(['packages/db/src/cli/migrate.ts'], { PGLITE_DIR: dir });
    expect(migrate.status).toBe(1);
    expect(migrate.stderr).toContain('[db:migrate] The local database');
    const reset = run(['packages/db/src/cli/reset.ts'], { PGLITE_DIR: dir });
    expect(reset.status).toBe(1);
    expect(existsSync(join(dir, 'PG_VERSION'))).toBe(true); // not wiped under the server
  }, 120_000);
});
