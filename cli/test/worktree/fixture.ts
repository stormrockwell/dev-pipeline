import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseAdapter, DatabaseTarget } from "../../src/commands/worktree/database.ts";

// The library spawns git with the process environment, so the identity has to live there.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
});

const parents: string[] = [];

export function removeFixtures(): void {
  for (const dir of parents.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export function put(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export interface Fixture {
  parent: string;
  repo: string;
  remote: string;
}

/**
 * A repo with a bare remote, ignored node_modules and vendor trees, and a few tracked files.
 * Worktrees land in the sibling directory the command picks by default, so one parent cleans up everything.
 */
export function makeFixture(): Fixture {
  // Git reports real paths, and macOS temp directories sit behind a symlink.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "pipeline-wt-")));
  parents.push(parent);
  const repo = join(parent, "site");
  const remote = join(parent, "origin.git");
  mkdirSync(repo);
  git(parent, "init", "-q", "--bare", "-b", "main", remote);
  git(repo, "init", "-q", "-b", "main");
  put(repo, ".gitignore", "node_modules/\nvendor/\n");
  put(repo, "package.json", '{"name":"site"}\n');
  put(repo, "a.txt", "a\n");
  put(repo, "b.txt", "b\n");
  put(repo, "shared.txt", "shared\n");
  put(repo, "node_modules/dep/index.js", "module.exports = 1;\n");
  put(repo, "vendor/lib/lib.php", "<?php\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "chore: initial commit");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  return { parent, repo, remote };
}

/** Parses the KEY="value" lines the command writes for a repo's test config to read. */
export function readEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)="(.*)"$/.exec(line);
    if (match) env[match[1]!] = match[2]!;
  }
  return env;
}

/** A database adapter that records calls, so unit tests need no MySQL. */
export class MemoryDatabase implements DatabaseAdapter {
  live = new Map<string, DatabaseTarget>();
  dropped: string[] = [];

  async create(target: DatabaseTarget): Promise<void> {
    if (this.live.has(target.name)) throw new Error(`database ${target.name} already exists`);
    mkdirSync(target.dir, { recursive: true });
    this.live.set(target.name, target);
  }

  async drop(target: DatabaseTarget): Promise<void> {
    this.live.delete(target.name);
    this.dropped.push(target.name);
  }
}
