import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { withLock } from "../../src/commands/worktree/lock.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-lock-"));
  dirs.push(dir);
  return join(dir, "test.lock");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withLock", () => {
  it("runs critical sections one at a time", async () => {
    const path = lockPath();
    let inside = 0;
    let peak = 0;
    const section = async () => {
      inside += 1;
      peak = Math.max(peak, inside);
      await sleep(40);
      inside -= 1;
    };
    await Promise.all([1, 2, 3, 4].map(() => withLock(path, { timeoutMs: 10_000 }, section)));
    expect(peak).toBe(1);
  });

  it("releases the lock when the section throws", async () => {
    const path = lockPath();
    await expect(withLock(path, { timeoutMs: 1000 }, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(withLock(path, { timeoutMs: 1000 }, async () => "ok")).resolves.toBe("ok");
  });

  it("gives up with a clear error when the holder never releases", async () => {
    const path = lockPath();
    let release!: () => void;
    const held = withLock(path, { timeoutMs: 1000 }, () => new Promise<void>((resolve) => (release = resolve)));
    await sleep(50);
    await expect(withLock(path, { timeoutMs: 200 }, async () => undefined)).rejects.toThrow(/timed out waiting for the lock/);
    release();
    await held;
  });

  it("reclaims a lock whose owner process is gone", async () => {
    const path = lockPath();
    mkdirSync(path);
    // A pid far above any real one stands in for a crashed owner.
    writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    await expect(withLock(path, { timeoutMs: 2000 }, async () => "reclaimed")).resolves.toBe("reclaimed");
  });

  it("reclaims an old lock that has no readable owner", async () => {
    const path = lockPath();
    mkdirSync(path);
    const old = new Date(Date.now() - 600_000);
    utimesSync(path, old, old);
    await expect(withLock(path, { timeoutMs: 2000, staleMs: 1000 }, async () => "reclaimed")).resolves.toBe("reclaimed");
  });
});
