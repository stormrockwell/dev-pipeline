import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LockOptions {
  // How long to wait for the holder before giving up.
  timeoutMs: number;
  // A lock older than this with no live owner is taken over.
  staleMs?: number;
}

const defaultStaleMs = 10 * 60_000;
const pollMs = 25;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isStale(path: string, staleMs: number): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { pid?: number };
    if (typeof owner.pid === "number") return !processAlive(owner.pid);
  } catch {
    // The owner file is written just after the directory appears, so fall back to the directory age.
  }
  try {
    return Date.now() - statSync(path).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * Creates the lock directory, which is atomic on every filesystem the pipeline targets. A stale lock is
 * renamed away first, so only one waiter can take it over.
 */
async function acquire(path: string, options: LockOptions): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (isStale(path, options.staleMs ?? defaultStaleMs)) {
      const aside = `${path}.stale-${process.pid}-${Date.now()}`;
      try {
        renameSync(path, aside);
        rmSync(aside, { recursive: true, force: true });
      } catch {
        // Another waiter reclaimed it first.
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for the lock at ${path}. Another worktree command may still be running.`);
    }
    await sleep(pollMs);
  }
}

export async function withLock<T>(path: string, options: LockOptions, section: () => Promise<T>): Promise<T> {
  await acquire(path, options);
  try {
    return await section();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
