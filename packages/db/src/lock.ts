import { closeSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';

/**
 * PGlite single-process lock (IOS-3/4 stream H, robustness (a)).
 *
 * PGlite is an embedded Postgres: two processes opening the same data dir corrupt it. Every opener of a local data
 * dir (`createPglite(dir)`, so `openDb()`, `getDb()` in the Next server, the worker and every CLI) first takes
 * `<dataDir>.lock`, created atomically (O_EXCL) and holding the owner's pid, role, origin and start time. A second
 * process is refused with a clear message instead of opening the database. A lock whose process is gone (a crash or
 * a kill -9) is stale and is taken over. One process may open the same dir more than once (reference counted).
 */

export interface LockInfo {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
  /** 'server' (Next dev/start), 'worker', 'cli' … */
  readonly role: string;
  /** The holder's dashboard origin when it is a server (where the Owner can do the same thing in the browser). */
  readonly origin: string | null;
  /** Short command line, for the message. */
  readonly command: string;
}

export class DbLockedError extends Error {
  override readonly name = 'DbLockedError';
  constructor(
    readonly lockPath: string,
    readonly holder: LockInfo,
    message: string,
  ) {
    super(message);
  }
}

/** `<dataDir>.lock`, beside the data dir (never inside it: PGlite owns that folder). */
export function lockPathFor(dataDir: string): string {
  return `${resolve(dataDir).replace(/[\\/]+$/, '')}.lock`;
}

/** Is the process alive? EPERM means it exists but belongs to someone else. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(dataDir: string): LockInfo | null {
  try {
    const raw = JSON.parse(readFileSync(lockPathFor(dataDir), 'utf8')) as Partial<LockInfo>;
    if (typeof raw.pid !== 'number') return null;
    return {
      pid: raw.pid,
      host: String(raw.host ?? ''),
      startedAt: String(raw.startedAt ?? ''),
      role: String(raw.role ?? 'unknown'),
      origin: typeof raw.origin === 'string' ? raw.origin : null,
      command: String(raw.command ?? ''),
    };
  } catch {
    return null;
  }
}

/** A lock held by a live process on this machine, or one from another host (which we can't check, so it counts). */
function liveHolder(info: LockInfo | null): boolean {
  if (!info) return false;
  if (info.host && info.host !== hostname()) return true;
  return processAlive(info.pid);
}

/** The process currently holding the data dir, other than this one; null when free (or held by this process). */
export function lockHolder(dataDir: string): LockInfo | null {
  const info = readLock(dataDir);
  if (!info || info.pid === process.pid) return null;
  return liveHolder(info) ? info : null;
}

/** Defaults for the lock record: a Next server is 'server' with its origin (IOS_PUBLIC_URL, else PORT, else 3100). */
export function defaultLockRole(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): { role: string; origin: string | null } {
  const cmd = argv.join(' ');
  if (env.NEXT_RUNTIME || /\bnext\b|next-server|start-server/.test(cmd)) {
    return { role: 'server', origin: (env.IOS_PUBLIC_URL?.trim() || `http://localhost:${env.PORT?.trim() || 3100}`).replace(/\/+$/, '') };
  }
  if (/apps[\\/]worker/.test(cmd)) return { role: 'worker', origin: null };
  return { role: 'cli', origin: null };
}

function describe(info: LockInfo): string {
  const since = info.startedAt ? ` since ${info.startedAt.slice(0, 16).replace('T', ' ')} UTC` : '';
  const who = info.role === 'server' ? `the dev server${info.origin ? ` at ${info.origin}` : ''}` : info.role === 'worker' ? '`pnpm worker`' : `another command${info.command ? ` (${info.command})` : ''}`;
  return `${who} (pid ${info.pid}${info.host && info.host !== hostname() ? ` on ${info.host}` : ''}${since})`;
}

function shortDir(dataDir: string): string {
  const rel = relative(process.cwd(), resolve(dataDir));
  return rel && !rel.startsWith('..') ? rel : resolve(dataDir);
}

/** The refusal every CLI prints. */
export function lockedMessage(dataDir: string, holder: LockInfo, hint?: string): string {
  return [
    `The local database (${shortDir(dataDir)}) is already open in ${describe(holder)}.`,
    'PGlite allows one process per data dir (two processes corrupt it), so this command did not open it.',
    ...(hint ? [hint] : []),
    `Stop that process first and run this again, or set DATABASE_URL to use Postgres.`,
    `(If no such process is running, delete ${basename(lockPathFor(dataDir))} in ${shortDir(dirname(lockPathFor(dataDir)))}.)`,
  ].join('\n');
}

const held = new Map<string, number>();
let exitHook = false;

function removeOwnLock(path: string): void {
  try {
    const info = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number };
    if (info.pid === process.pid) unlinkSync(path);
  } catch {
    // already gone
  }
}

/**
 * Takes the lock for `dataDir` (throws DbLockedError when a live process holds it). Returns the release function;
 * the lock is also removed when this process exits.
 */
export function acquirePgliteLock(dataDir: string, opts: { role?: string; origin?: string | null } = {}): () => void {
  const path = lockPathFor(dataDir);
  const count = held.get(path) ?? 0;
  if (count > 0) {
    held.set(path, count + 1);
    return once(() => release(path));
  }
  const defaults = defaultLockRole();
  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    role: opts.role ?? defaults.role,
    origin: opts.origin !== undefined ? opts.origin : defaults.origin,
    command: process.argv.slice(1).map((a) => basename(a)).join(' ').slice(0, 120),
  };
  const raw = JSON.stringify(info);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (tryCreate(path, raw)) return acquired(path);
    const current = readLock(dataDir);
    if (current && current.pid === process.pid) {
      // Our own lock from an earlier open whose release we lost track of (e.g. a module reload): reuse it.
      held.set(path, 1);
      return once(() => release(path));
    }
    if (current && liveHolder(current)) throw new DbLockedError(path, current, lockedMessage(dataDir, current));
    // Stale (crashed holder) or unreadable. The takeover is serialized through `<lock>.takeover` (O_EXCL), and the
    // holder re-checks the lock inside it, so two contenders can never both unlink-and-create: without the guard a slow
    // process could unlink the fresh lock a faster one had just created, and both would open the data dir.
    const outcome = takeOver(path, dataDir, raw);
    if (outcome === 'acquired') return acquired(path);
    if (outcome === 'busy') sleepMs(5 + Math.floor(Math.random() * 20));
  }
  const current = readLock(dataDir);
  throw new DbLockedError(path, current ?? info, current ? lockedMessage(dataDir, current) : `Couldn't take the database lock ${path}.`);
}

/** O_EXCL create with our record; false when the file exists. */
function tryCreate(path: string, raw: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  }
  try {
    writeSync(fd, raw);
  } finally {
    closeSync(fd);
  }
  return true;
}

function acquired(path: string): () => void {
  held.set(path, 1);
  if (!exitHook) {
    exitHook = true;
    process.once('exit', () => {
      for (const p of held.keys()) removeOwnLock(p);
    });
  }
  return once(() => release(path));
}

const guardPathFor = (path: string) => `${path}.takeover`;

/**
 * Replaces a stale lock while holding the takeover guard. 'acquired' = the lock is ours; 'retry' = the lock changed
 * (someone else took it, or it went away), go round again; 'busy' = another process is taking over right now.
 */
function takeOver(path: string, dataDir: string, raw: string): 'acquired' | 'retry' | 'busy' {
  const guard = guardPathFor(path);
  if (!tryCreate(guard, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }))) {
    clearStaleGuard(guard);
    return 'busy';
  }
  try {
    // Re-check inside the guard: only a lock that is still stale is removed.
    const current = readLock(dataDir);
    if (current && (current.pid === process.pid || liveHolder(current))) return 'retry';
    // Unreadable and fresh: its creator is between the O_EXCL create and the write. Never remove that one.
    if (!current && ageMs(path) < HALF_WRITTEN_MS) return 'busy';
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
    return tryCreate(path, raw) ? 'acquired' : 'retry';
  } finally {
    try {
      unlinkSync(guard);
    } catch {
      // ignore
    }
  }
}

/**
 * A guard left by a process that crashed mid-takeover. It is moved aside atomically (rename) and checked again; if the
 * file moved was in fact a live guard (it changed between the read and the rename), it is put back with link(), which
 * never overwrites.
 */
function clearStaleGuard(guard: string): void {
  let pid: number | null = null;
  let host = '';
  try {
    const g = JSON.parse(readFileSync(guard, 'utf8')) as { pid?: unknown; host?: unknown };
    pid = typeof g.pid === 'number' ? g.pid : null;
    host = typeof g.host === 'string' ? g.host : '';
  } catch {
    // unreadable or half-written: give its writer a moment; an old unreadable guard is a crash leftover
    if (ageMs(guard) < HALF_WRITTEN_MS) return;
  }
  if ((pid !== null && host && host !== hostname()) || (pid !== null && processAlive(pid))) return;
  const aside = `${guard}.${process.pid}.${Date.now()}`;
  try {
    renameSync(guard, aside);
  } catch {
    return;
  }
  try {
    const moved = (() => {
      try {
        return JSON.parse(readFileSync(aside, 'utf8')) as { pid?: unknown };
      } catch {
        return {};
      }
    })();
    const live = typeof moved.pid === 'number' ? moved.pid !== pid && processAlive(moved.pid) : ageMs(aside) < HALF_WRITTEN_MS;
    if (live) {
      try {
        linkSync(aside, guard);
      } catch {
        // a new guard exists already
      }
    }
  } catch {
    // ignore
  } finally {
    try {
      unlinkSync(aside);
    } catch {
      // ignore
    }
  }
}

/** How long an unreadable lock or guard may be "being written" before it counts as a crash leftover. */
const HALF_WRITTEN_MS = 2_000;

function ageMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Synchronous short sleep (lock acquisition is synchronous). */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function release(path: string): void {
  const n = held.get(path) ?? 0;
  if (n > 1) {
    held.set(path, n - 1);
    return;
  }
  held.delete(path);
  removeOwnLock(path);
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/** Throws DbLockedError when another live process holds `dataDir` (for commands that touch the dir without opening it). */
export function assertPgliteFree(dataDir: string, hint?: string): void {
  const holder = lockHolder(dataDir);
  if (holder) throw new DbLockedError(lockPathFor(dataDir), holder, lockedMessage(dataDir, holder, hint));
}

/**
 * For CLIs: prints a clear refusal for a held lock (or the open error) and exits non-zero. `hint` adds a line for
 * the locked case, e.g. where to do the same thing in the running dashboard.
 */
export function exitOnOpenError(tool: string, err: unknown, hint?: (holder: LockInfo) => string | undefined): never {
  if (err instanceof DbLockedError) {
    const extra = hint?.(err.holder);
    const lines = err.message.split('\n');
    if (extra) lines.splice(2, 0, extra);
    console.error(`[${tool}] ${lines.join(`\n[${tool}] `)}`);
  } else {
    console.error(`[${tool}] Couldn't open the database: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}
