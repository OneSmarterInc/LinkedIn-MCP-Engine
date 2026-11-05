import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { logger } from "../lib/logger.js";

/**
 * One job search, one campaign run at a time, across processes.
 *
 * The API (npm run api), the MCP server (Claude Desktop) and the CLI are separate Node processes, so a flag in
 * memory cannot stop two of them starting the same work. A lock is a small file in out/locks/ created with the
 * O_EXCL flag, which the file system makes atomic: exactly one caller wins. The file records who holds it and since
 * when. A lock older than `staleMs` (default 30 minutes) is treated as left behind by a crashed process and taken
 * over, so nothing can block the engine forever.
 */

export type LockName = "job-search" | "campaign-run";

export class LockHeldError extends Error {
  readonly statusCode = 409;
  constructor(name: LockName, holder: LockInfo) {
    const since = Math.max(0, Math.round((Date.now() - Date.parse(holder.started_at)) / 60_000));
    super(`${name === "job-search" ? "A job search" : "A campaign run"} is already running (started ${since} min ago${holder.label ? ` by ${holder.label}` : ""}). Wait for it to finish.`);
    this.name = "LockHeldError";
  }
}

export interface LockInfo { pid: number; host: string; started_at: string; label?: string }
export interface LockOptions {
  /** Folder for lock files. Default out/locks under the current working directory (LOCK_DIR in .env overrides). */
  dir?: string;
  /** A lock older than this is considered abandoned. Default 30 minutes. */
  staleMs?: number;
  /** Who is taking the lock, for the message the other side sees ("api", "mcp", "cli"). */
  label?: string;
  now?: () => number;
}

export const DEFAULT_LOCK_STALE_MS = 30 * 60_000;

export function lockDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOCK_DIR?.trim() ? resolve(env.LOCK_DIR.trim()) : resolve(process.cwd(), "out", "locks");
}

function lockPath(dir: string, name: LockName): string { return resolve(dir, `${name}.lock`); }

/** True when a process with this pid is alive on this machine. Another host's pid cannot be checked, so assume alive. */
function holderAlive(info: LockInfo): boolean {
  if (info.host !== hostname()) return true;
  try { process.kill(info.pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

async function readLock(path: string): Promise<LockInfo | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as LockInfo; } catch { return undefined; }
}

/**
 * Takes the lock or throws LockHeldError (HTTP 409). Returns a release function; call it in a finally, or when the
 * background work ends. Releasing twice, or after the file was removed by hand, is harmless.
 */
export async function acquireLock(name: LockName, opts: LockOptions = {}): Promise<() => Promise<void>> {
  const dir = opts.dir ?? lockDir();
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const now = opts.now ?? Date.now;
  const path = lockPath(dir, name);
  await mkdir(dir, { recursive: true });
  const info: LockInfo = { pid: process.pid, host: hostname(), started_at: new Date(now()).toISOString(), ...(opts.label ? { label: opts.label } : {}) };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(path, "wx"); // fails with EEXIST when another process holds it
      try { await fh.writeFile(JSON.stringify(info)); } finally { await fh.close(); }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const current = await readLock(path);
        if (current && (current.pid !== info.pid || current.started_at !== info.started_at)) return; // taken over; not ours any more
        try { await unlink(path); } catch { /* already gone */ }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = await readLock(path);
      const age = holder ? now() - Date.parse(holder.started_at) : Number.POSITIVE_INFINITY;
      const abandoned = !holder || Number.isNaN(age) || age > staleMs || !holderAlive(holder);
      if (!abandoned) throw new LockHeldError(name, holder!);
      logger.warn({ lock: name, holder }, "taking over an abandoned lock");
      try { await unlink(path); } catch { /* another process beat us to it; the next attempt decides */ }
    }
  }
  const holder = (await readLock(path)) ?? { pid: 0, host: "?", started_at: new Date(now()).toISOString() };
  throw new LockHeldError(name, holder);
}

/** Runs `fn` under the lock and releases it when `fn` settles. For work that finishes before the caller returns. */
export async function withLock<T>(name: LockName, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const release = await acquireLock(name, opts);
  try { return await fn(); } finally { await release(); }
}
