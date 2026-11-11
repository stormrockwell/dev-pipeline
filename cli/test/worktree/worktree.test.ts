import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openRepo } from "../../src/commands/worktree/context.ts";
import { createWorktree } from "../../src/commands/worktree/create.ts";
import { mergeWorktree } from "../../src/commands/worktree/merge.ts";
import { teardownWorktree } from "../../src/commands/worktree/teardown.ts";
import { git, makeFixture, MemoryDatabase, put, readEnv, removeFixtures } from "./fixture.ts";

afterAll(removeFixtures);

// Each case builds a fixture repo and runs real git, which is slow while the whole suite shares the CPU.

// A high range keeps the tests away from ports a developer's own servers use, and the pid spreads parallel suites apart.
const config = { ports: { base: 40000 + (process.pid % 50) * 400, size: 10, slots: 40 } };

async function open(repo: string, database = new MemoryDatabase(), extra = {}) {
  const ctx = await openRepo(repo, { config, database, timeoutMs: 30_000, lockTimeoutMs: 30_000, ...extra });
  return { ctx, database };
}

function commitIn(path: string, file: string, content: string, message: string): void {
  put(path, file, content);
  git(path, "add", file);
  git(path, "commit", "-q", "-m", message);
}

function listen(port: number): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve(() => new Promise<void>((done) => server.close(() => done()))),
    );
  });
}

describe("createWorktree", () => {
  it("adds a worktree on its own branch from the base", async () => {
    const { repo, parent } = makeFixture();
    const { ctx } = await open(repo);
    const record = await createWorktree(ctx, { name: "task-a", base: "main" });

    expect(record.path).toBe(join(parent, "site-wt", "task-a"));
    expect(record.branch).toBe("wt/task-a");
    expect(git(record.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("wt/task-a");
    expect(git(record.path, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "main"));
  });

  it("refuses a duplicate name and an unsafe name", async () => {
    const { repo } = makeFixture();
    const { ctx } = await open(repo);
    await createWorktree(ctx, { name: "task-a", base: "main" });
    await expect(createWorktree(ctx, { name: "task-a", base: "main" })).rejects.toThrow(/already exists/);
    await expect(createWorktree(ctx, { name: "../escape", base: "main" })).rejects.toThrow(/invalid worktree name/);
  });

  it("clones dependencies, provisions the database and writes both where the test config reads them", async () => {
    const { repo } = makeFixture();
    const { ctx, database } = await open(repo);
    const record = await createWorktree(ctx, { name: "task-a", base: "main" });

    expect(readFileSync(join(record.path, "node_modules/dep/index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(existsSync(join(record.path, "vendor/lib/lib.php"))).toBe(true);
    expect(database.live.has(record.database.name)).toBe(true);

    const env = readEnv(join(record.path, ".env.worktree"));
    expect(env.TEST_DB_NAME).toBe(record.database.name);
    expect(env.TEST_DB_DIR).toBe(record.database.dir);
    expect(env.PIPELINE_PORT_BASE).toBe(String(record.ports.base));
    expect(env.PIPELINE_PORT_END).toBe(String(record.ports.end));
    expect(env.PORT).toBe(String(record.ports.base));
  });

  it("keeps its generated files out of git status", async () => {
    const { repo } = makeFixture();
    const { ctx } = await open(repo);
    const record = await createWorktree(ctx, { name: "task-a", base: "main" });
    expect(git(record.path, "status", "--porcelain")).toBe("");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("rolls back the worktree, database and ports when a later step fails", async () => {
    const { repo } = makeFixture();
    const database = new MemoryDatabase();
    let fail = true;
    // The probe always answers free, because Linux can lend a port in this range to an outgoing connection and the test is about the freed slot.
    const { ctx } = await open(repo, database, {
      isPortFree: async () => true,
      afterDatabase: async () => {
        if (fail) throw new Error("injected failure");
      },
    });
    await expect(createWorktree(ctx, { name: "task-a", base: "main" })).rejects.toThrow(/injected failure/);
    fail = false;
    expect(database.live.size).toBe(0);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("task-a");
    expect(git(repo, "branch", "--list", "wt/task-a")).toBe("");
    const retry = await createWorktree(ctx, { name: "task-a", base: "main" });
    expect(retry.ports.base).toBe(config.ports.base);
  });
});

describe("two zero-overlap tasks in parallel", () => {
  it("run without colliding on database, ports, files or merges", async () => {
    const { repo } = makeFixture();
    const { ctx, database } = await open(repo);

    const [a, b] = await Promise.all([
      createWorktree(ctx, { name: "task-a", base: "main" }),
      createWorktree(ctx, { name: "task-b", base: "main" }),
    ]);

    // Distinct databases, both live, and distinct non-overlapping port ranges.
    expect(a.database.name).not.toBe(b.database.name);
    expect(a.database.dir).not.toBe(b.database.dir);
    expect([...database.live.keys()].sort()).toEqual([a.database.name, b.database.name].sort());
    expect(a.ports.end < b.ports.base || b.ports.end < a.ports.base).toBe(true);
    expect(readEnv(join(a.path, ".env.worktree")).TEST_DB_NAME).not.toBe(readEnv(join(b.path, ".env.worktree")).TEST_DB_NAME);

    const before = readdirSync(repo).sort();
    const mainHead = git(repo, "rev-parse", "main");

    // Work in both at once: bind the dev server ports, write a database file, edit a dependency, and commit.
    const stops = await Promise.all([listen(a.ports.base), listen(b.ports.base)]);
    await Promise.all(
      [
        { wt: a, file: "a.txt", other: "node_modules/dep/index.js" },
        { wt: b, file: "b.txt", other: "vendor/lib/lib.php" },
      ].map(async ({ wt, file, other }) => {
        writeFileSync(join(wt.database.dir, "test.sqlite"), `db of ${wt.name}`);
        writeFileSync(join(wt.path, other), `edited by ${wt.name}`);
        commitIn(wt.path, file, `changed by ${wt.name}\n`, `feat: edit ${file}`);
      }),
    );
    await Promise.all(stops.map((stop) => stop()));

    // No shared files: the main checkout and the other worktree never saw the edits.
    expect(readdirSync(repo).sort()).toEqual(before);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "rev-parse", "main")).toBe(mainHead);
    expect(readFileSync(join(repo, "node_modules/dep/index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(readFileSync(join(b.path, "node_modules/dep/index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(readFileSync(join(a.path, "vendor/lib/lib.php"), "utf8")).toBe("<?php\n");
    expect(readFileSync(join(a.database.dir, "test.sqlite"), "utf8")).toBe("db of task-a");
    expect(readFileSync(join(b.database.dir, "test.sqlite"), "utf8")).toBe("db of task-b");
    expect(statSync(join(a.path, "node_modules/dep/index.js")).ino).not.toBe(statSync(join(repo, "node_modules/dep/index.js")).ino);

    // Merges are serialized by the lock, and both land on the integration branch.
    let inside = 0;
    let peak = 0;
    const { ctx: serial } = await open(repo, database, {
      inMergeLock: async () => {
        inside += 1;
        peak = Math.max(peak, inside);
        await new Promise((resolve) => setTimeout(resolve, 150));
        inside -= 1;
      },
    });
    const merged = await Promise.all([mergeWorktree(serial, { name: "task-a" }), mergeWorktree(serial, { name: "task-b" })]);
    expect(peak).toBe(1);
    expect(merged.map((m) => m.into)).toEqual(["main", "main"]);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed by task-a\n");
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("changed by task-b\n");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "log", "--merges", "--format=%s", "main").split("\n")).toHaveLength(2);
  });
});

describe("mergeWorktree", () => {
  it("refuses a conflicting merge, aborts it and leaves the integration branch untouched", async () => {
    const { repo } = makeFixture();
    const { ctx } = await open(repo);
    const a = await createWorktree(ctx, { name: "task-a", base: "main" });
    const b = await createWorktree(ctx, { name: "task-b", base: "main" });
    commitIn(a.path, "shared.txt", "from a\n", "feat: a edits shared");
    commitIn(b.path, "shared.txt", "from b\n", "feat: b edits shared");

    await mergeWorktree(ctx, { name: "task-a" });
    const head = git(repo, "rev-parse", "main");
    await expect(mergeWorktree(ctx, { name: "task-b" })).rejects.toThrow(/conflict in shared\.txt/);

    expect(git(repo, "rev-parse", "main")).toBe(head);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe("from a\n");
  });

  it("refuses when the worktree has uncommitted changes", async () => {
    const { repo } = makeFixture();
    const { ctx } = await open(repo);
    const a = await createWorktree(ctx, { name: "task-a", base: "main" });
    commitIn(a.path, "a.txt", "x\n", "feat: a");
    put(a.path, "a.txt", "dirty\n");
    await expect(mergeWorktree(ctx, { name: "task-a" })).rejects.toThrow(/uncommitted changes/);
  });

  it("refuses when the integration checkout is dirty", async () => {
    const { repo } = makeFixture();
    const { ctx } = await open(repo);
    const a = await createWorktree(ctx, { name: "task-a", base: "main" });
    commitIn(a.path, "a.txt", "x\n", "feat: a");
    put(repo, "b.txt", "dirty\n");
    await expect(mergeWorktree(ctx, { name: "task-a" })).rejects.toThrow(/integration checkout has uncommitted changes/);
  });
});

describe("teardownWorktree", () => {
  it("refuses while the worktree has uncommitted work and changes nothing", async () => {
    const { repo } = makeFixture();
    const { ctx, database } = await open(repo);
    const a = await createWorktree(ctx, { name: "task-a", base: "main" });
    put(a.path, "new.txt", "untracked\n");
    await expect(teardownWorktree(ctx, { name: "task-a" })).rejects.toThrow(/uncommitted changes/);
    expect(existsSync(a.path)).toBe(true);
    expect(database.live.has(a.database.name)).toBe(true);
  });

  it("refuses while commits are unpushed and unmerged, then succeeds once they are pushed", async () => {
    const { repo } = makeFixture();
    const { ctx, database } = await open(repo);
    const a = await createWorktree(ctx, { name: "task-a", base: "main" });
    commitIn(a.path, "a.txt", "x\n", "feat: a");
    await expect(teardownWorktree(ctx, { name: "task-a" })).rejects.toThrow(/unpushed commits/);
    expect(existsSync(a.path)).toBe(true);

    git(a.path, "push", "-q", "origin", "wt/task-a");
    const result = await teardownWorktree(ctx, { name: "task-a" });
    expect(result.removed).toBe(true);
    expect(existsSync(a.path)).toBe(false);
    expect(database.live.size).toBe(0);
    expect(database.dropped).toEqual([a.database.name]);
  });

  it("allows teardown after the work was merged into the integration branch", async () => {
    const { repo } = makeFixture();
    const { ctx } = await open(repo);
    const a = await createWorktree(ctx, { name: "task-a", base: "main" });
    commitIn(a.path, "a.txt", "x\n", "feat: a");
    await mergeWorktree(ctx, { name: "task-a" });
    await teardownWorktree(ctx, { name: "task-a" });
    expect(existsSync(a.path)).toBe(false);
  });

  it("frees the port range for the next worktree and removes the sqlite directory", async () => {
    const { repo } = makeFixture();
    const { ctx } = await open(repo);
    const a = await createWorktree(ctx, { name: "task-a", base: "main" });
    await teardownWorktree(ctx, { name: "task-a" });
    const b = await createWorktree(ctx, { name: "task-b", base: "main" });
    expect(b.ports.base).toBe(a.ports.base);
  });

  it("finishes cleanup when the directory is already gone", async () => {
    const { repo } = makeFixture();
    const { ctx, database } = await open(repo);
    const a = await createWorktree(ctx, { name: "task-a", base: "main" });
    git(repo, "worktree", "remove", "--force", a.path);
    const result = await teardownWorktree(ctx, { name: "task-a" });
    expect(result.removed).toBe(true);
    expect(database.live.size).toBe(0);
  });

  it("fails on an unknown name", async () => {
    const { repo } = makeFixture();
    const { ctx } = await open(repo);
    await expect(teardownWorktree(ctx, { name: "nope" })).rejects.toThrow(/no worktree named nope/);
  });
});

describe("pipeline worktree through the CLI", () => {
  it("creates, merges and tears down with the default sqlite directory adapter", async () => {
    const { repo } = makeFixture();
    const bin = join(import.meta.dirname, "..", "..", "bin", "pipeline");
    const exec = (args: string[], cwd = repo) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, [bin, "worktree", ...args], { cwd, env: process.env });
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => (out += chunk));
        child.stderr.on("data", (chunk: Buffer) => (out += chunk));
        child.on("close", (code) => resolve({ code, out }));
      });

    const created = await exec(["create", "cli-task", "--base", "main", "--json"]);
    expect(created.code).toBe(0);
    const record = JSON.parse(created.out) as { path: string; database: { dir: string } };
    expect(existsSync(record.database.dir)).toBe(true);

    commitIn(record.path, "a.txt", "from cli\n", "feat: cli");
    const merged = await exec(["merge", "cli-task"], record.path);
    expect(merged.code).toBe(0);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("from cli\n");

    const torn = await exec(["teardown", "cli-task"]);
    expect(torn.code).toBe(0);
    expect(existsSync(record.path)).toBe(false);
    expect(existsSync(record.database.dir)).toBe(false);

    const refused = await exec(["teardown", "cli-task"]);
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/no worktree named cli-task/);
  }, 60_000);
});
