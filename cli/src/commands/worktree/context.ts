import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "./config.ts";
import type { ConfigOverride, WorktreeConfig } from "./config.ts";
import { mysqlAdapter, noDatabaseAdapter, sqliteDirAdapter } from "./database.ts";
import type { DatabaseAdapter } from "./database.ts";
import { gitOk } from "./git.ts";
import { probePort } from "./ports.ts";

export interface Overrides {
  config?: ConfigOverride;
  // Replaces the adapter the config would pick, so tests need no MySQL.
  database?: DatabaseAdapter;
  isPortFree?: (port: number) => Promise<boolean>;
  // Hard limit for every external process.
  timeoutMs?: number;
  // How long to wait for the registry or merge lock.
  lockTimeoutMs?: number;
  // Runs while the merge lock is held, which lets tests observe serialization.
  inMergeLock?: () => Promise<void>;
  // Runs after the database exists, which lets tests exercise rollback.
  afterDatabase?: () => Promise<void>;
}

export interface Context {
  // The primary checkout, which holds the integration branch.
  primary: string;
  repoName: string;
  // Registry, records and locks live in the git directory, so they are never tracked and every worktree shares them.
  stateDir: string;
  excludeFile: string;
  config: WorktreeConfig;
  database: DatabaseAdapter;
  isPortFree: (port: number) => Promise<boolean>;
  timeoutMs: number;
  lockTimeoutMs: number;
  inMergeLock?: () => Promise<void>;
  afterDatabase?: () => Promise<void>;
}

export const defaultTimeoutMs = 120_000;
export const defaultLockTimeoutMs = 300_000;

export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

/** Resolves the primary checkout and shared state from any directory inside the repo or one of its worktrees. */
export async function openRepo(cwd: string, overrides: Overrides = {}): Promise<Context> {
  const timeoutMs = overrides.timeoutMs ?? defaultTimeoutMs;
  const listing = await gitOk(cwd, ["worktree", "list", "--porcelain"], timeoutMs);
  const first = listing.split("\n").find((line) => line.startsWith("worktree "));
  if (!first) throw new Error(`${cwd} is not inside a git repository.`);
  const primary = realpathSync(first.slice("worktree ".length));
  const commonDir = realpathSync(await gitOk(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], timeoutMs));
  const excludeFile = await gitOk(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], timeoutMs);
  const config = loadConfig(primary, overrides.config);

  const database =
    overrides.database ??
    (config.database.kind === "mysql"
      ? mysqlAdapter({ client: config.database.mysqlClient, args: config.database.mysqlArgs, timeoutMs })
      : config.database.kind === "sqlite-dir"
        ? sqliteDirAdapter
        : noDatabaseAdapter);

  return {
    primary,
    repoName: basename(primary),
    stateDir: join(commonDir, "pipeline"),
    excludeFile,
    config,
    database,
    isPortFree: overrides.isPortFree ?? probePort,
    timeoutMs,
    lockTimeoutMs: overrides.lockTimeoutMs ?? defaultLockTimeoutMs,
    inMergeLock: overrides.inMergeLock,
    afterDatabase: overrides.afterDatabase,
  };
}
