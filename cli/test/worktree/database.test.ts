import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { databaseName, mysqlAdapter, sqliteDirAdapter } from "../../src/commands/worktree/database.ts";

const temps: string[] = [];
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("databaseName", () => {
  it("derives a stable MySQL safe name", () => {
    const name = databaseName("My Site", "task-1", "/work/site-wt/task-1");
    expect(name).toMatch(/^wt_my_site_task_1_[0-9a-f]{6}$/);
    expect(databaseName("My Site", "task-1", "/work/site-wt/task-1")).toBe(name);
  });

  it("differs by worktree path and stays within the 64 character limit", () => {
    expect(databaseName("site", "a", "/one/a")).not.toBe(databaseName("site", "a", "/two/a"));
    expect(databaseName("x".repeat(200), "y".repeat(200), "/p").length).toBeLessThanOrEqual(64);
  });
});

describe("sqliteDirAdapter", () => {
  it("creates and removes the directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipeline-db-"));
    temps.push(root);
    const dir = join(root, "nested", "db");
    await sqliteDirAdapter.create({ name: "wt_x", dir });
    expect(existsSync(dir)).toBe(true);
    await sqliteDirAdapter.drop({ name: "wt_x", dir });
    expect(existsSync(dir)).toBe(false);
  });
});

describe("mysqlAdapter", () => {
  it("issues quoted create and drop statements through the client with a timeout", async () => {
    const calls: { file: string; args: string[]; timeoutMs: number }[] = [];
    const adapter = mysqlAdapter({
      client: "mysql",
      timeoutMs: 5000,
      exec: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs });
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      },
    });
    await adapter.create({ name: "wt_site_a_123abc", dir: "/unused" });
    await adapter.drop({ name: "wt_site_a_123abc", dir: "/unused" });
    expect(calls.map((call) => call.args.at(-1))).toEqual([
      "CREATE DATABASE IF NOT EXISTS `wt_site_a_123abc`",
      "DROP DATABASE IF EXISTS `wt_site_a_123abc`",
    ]);
    expect(calls.every((call) => call.file === "mysql" && call.timeoutMs === 5000)).toBe(true);
  });

  it("refuses a name that could break out of the statement", async () => {
    const adapter = mysqlAdapter({ client: "mysql", timeoutMs: 1000, exec: async () => Promise.reject(new Error("unreachable")) });
    await expect(adapter.create({ name: "x`; DROP DATABASE mysql; --", dir: "/unused" })).rejects.toThrow(/invalid database name/);
  });

  it("reports a timeout as a failure", async () => {
    const adapter = mysqlAdapter({
      client: "mysql",
      timeoutMs: 1000,
      exec: async () => ({ exitCode: null, timedOut: true, stdout: "", stderr: "" }),
    });
    await expect(adapter.create({ name: "wt_a", dir: "/unused" })).rejects.toThrow(/timed out/);
  });
});

const mysqlUp = spawnSync("mysql", ["--connect-timeout=3", "-e", "SELECT 1"], { stdio: "ignore", timeout: 10_000 }).status === 0;

describe.skipIf(!mysqlUp)("mysqlAdapter against a local server", () => {
  it("creates and drops a real database", async () => {
    const name = `wt_pipeline_test_${process.pid}`;
    const adapter = mysqlAdapter({ client: "mysql", timeoutMs: 20_000 });
    const listed = () =>
      spawnSync("mysql", ["-N", "-e", `SHOW DATABASES LIKE '${name}'`], { encoding: "utf8", timeout: 10_000 }).stdout.trim();
    try {
      await adapter.create({ name, dir: "/unused" });
      expect(listed()).toBe(name);
      await adapter.drop({ name, dir: "/unused" });
      expect(listed()).toBe("");
    } finally {
      spawnSync("mysql", ["-e", `DROP DATABASE IF EXISTS \`${name}\``], { stdio: "ignore", timeout: 10_000 });
    }
  }, 60_000);
});
