import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openRepo } from "../../src/commands/worktree/context.ts";
import { createWorktree } from "../../src/commands/worktree/create.ts";
import { sweepWorktrees } from "../../src/commands/worktree/sweep.ts";
import { executable, findOnPath, pipeline, removeTemps, tempDir } from "../helpers/repo.ts";
import { git, makeFixture, MemoryDatabase, put, removeFixtures } from "./fixture.ts";

afterAll(() => {
  removeFixtures();
  removeTemps();
});

const config = { ports: { base: 44000 + (process.pid % 50) * 400, size: 10, slots: 40 } };

const open = (repo: string) => openRepo(repo, { config, database: new MemoryDatabase(), timeoutMs: 30_000, lockTimeoutMs: 30_000 });

/**
 * A worktree made with plain git beside the repo, with one pushed commit on its branch
 */
function branchWorktree(repo: string, parent: string, name: string): { path: string; tip: string } {
  const path = join(parent, "site-wt", name);
  git(repo, "worktree", "add", "-q", "-b", `feat/${name}`, path, "main");
  put(path, `${name}.txt`, `${name}\n`);
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", `feat: ${name}`);
  git(path, "push", "-q", "origin", `feat/${name}`);
  return { path, tip: git(path, "rev-parse", "HEAD") };
}

describe("sweepWorktrees", () => {
  it("removes a clean worktree whose pull request merged at its tip, with its branch, and keeps the rest", async () => {
    const { repo, parent } = makeFixture();
    const done = branchWorktree(repo, parent, "done");
    const dirty = branchWorktree(repo, parent, "dirty");
    const pending = branchWorktree(repo, parent, "open");
    const moved = branchWorktree(repo, parent, "moved");
    put(dirty.path, "scratch.txt", "not committed\n");
    const merged = new Map([
      ["feat/done", { tip: done.tip, pr: 11 }],
      ["feat/dirty", { tip: dirty.tip, pr: 12 }],
      ["feat/moved", { tip: "0".repeat(40), pr: 13 }],
    ]);
    const asked: string[] = [];
    const lookup = async (branch: string, tip: string) => {
      asked.push(branch);
      const found = merged.get(branch);
      return found !== undefined && found.tip === tip ? found.pr : null;
    };

    const result = await sweepWorktrees(await open(repo), lookup);

    expect(result.rows).toHaveLength(4);
    expect(result.rows).toEqual(expect.arrayContaining([
      { path: done.path, branch: "feat/done", removed: true, pr: 11, reason: "pull request #11 merged" },
      { path: dirty.path, branch: "feat/dirty", removed: false, pr: 12, reason: "pull request #12 merged, but it has uncommitted work" },
      { path: pending.path, branch: "feat/open", removed: false, pr: null, reason: "no merged pull request at its tip" },
      { path: moved.path, branch: "feat/moved", removed: false, pr: null, reason: "no merged pull request at its tip" },
    ]));
    expect(existsSync(done.path)).toBe(false);
    expect(git(repo, "branch", "--list", "feat/done")).toBe("");
    expect(existsSync(dirty.path)).toBe(true);
    expect(git(repo, "branch", "--list", "feat/open")).toContain("feat/open");
    expect(asked.sort()).toEqual(["feat/dirty", "feat/done", "feat/moved", "feat/open"]);
  });

  it("changes nothing on a dry run, and leaves a worktree that create made to teardown", async () => {
    const { repo, parent } = makeFixture();
    const done = branchWorktree(repo, parent, "done");
    const ctx = await open(repo);
    const record = await createWorktree(ctx, { name: "task-a", base: "main" });

    const result = await sweepWorktrees(ctx, async () => 7, { dryRun: true });

    expect(result.rows.map((row) => [row.branch, row.removed, row.reason])).toEqual(expect.arrayContaining([
      ["feat/done", false, "pull request #7 merged, so a sweep removes it"],
      ["wt/task-a", false, "made by pipeline worktree create, so run pipeline worktree teardown task-a"],
    ]));
    expect(existsSync(done.path)).toBe(true);
    expect(existsSync(record.path)).toBe(true);
  });

  it("fast-forwards the primary checkout first when asked", async () => {
    const { repo, parent, remote } = makeFixture();
    const other = join(parent, "other");
    git(parent, "clone", "-q", remote, other);
    put(other, "c.txt", "c\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "feat: c");
    git(other, "push", "-q", "origin", "main");
    git(repo, "branch", "-q", "--set-upstream-to=origin/main", "main");

    const result = await sweepWorktrees(await open(repo), async () => null, { pull: true });

    expect(result.pulled).toContain("feat: c");
    expect(result.rows).toEqual([]);
  });
});

describe("pipeline worktree sweep", () => {
  it("asks gh for the merged pull request and removes the worktree", () => {
    const { repo, parent } = makeFixture();
    const done = branchWorktree(repo, parent, "done");
    const bin = tempDir("pipeline-gh-");
    executable(join(bin, "gh"), `#!/bin/sh\necho '[{"number":21,"headRefOid":"${done.tip}"}]'\n`);
    const path = [bin, dirname(process.execPath), dirname(findOnPath("git")), "/usr/bin", "/bin"].join(":");

    const result = pipeline(repo, ["worktree", "sweep"], { env: { PATH: path } });

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`Removed ${done.path} (feat/done): pull request #21 merged.\n`);
    expect(existsSync(done.path)).toBe(false);
  });
});
