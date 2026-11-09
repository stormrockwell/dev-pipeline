import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { run } from "../check/exec.ts";

export interface DatabaseTarget {
  name: string;
  // A directory inside the worktree, used by file based databases.
  dir: string;
}

export interface DatabaseAdapter {
  create(target: DatabaseTarget): Promise<void>;
  drop(target: DatabaseTarget): Promise<void>;
}

export interface ExecOutcome {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

export type Exec = (file: string, args: string[], timeoutMs: number, cwd?: string) => Promise<ExecOutcome>;

export const execProcess: Exec = (file, args, timeoutMs, cwd = process.cwd()) => run(file, args, cwd, timeoutMs);

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// MySQL caps a database name at 64 characters, and the path hash keeps same named worktrees in different checkouts apart.
export function databaseName(repo: string, worktree: string, path: string): string {
  const hash = createHash("sha1").update(path).digest("hex").slice(0, 6);
  const stem = `${slug(repo)}_${slug(worktree)}`.slice(0, 64 - "wt_".length - "_".length - hash.length);
  return `wt_${stem}_${hash}`;
}

export const sqliteDirAdapter: DatabaseAdapter = {
  async create({ dir }) {
    mkdirSync(dir, { recursive: true });
  },
  async drop({ dir }) {
    rmSync(dir, { recursive: true, force: true });
  },
};

export const noDatabaseAdapter: DatabaseAdapter = {
  async create() {},
  async drop() {},
};

export interface MysqlOptions {
  client: string;
  // Connection flags such as -h and -u. A password belongs in MYSQL_PWD, never in config.
  args?: string[];
  timeoutMs: number;
  exec?: Exec;
}

export function mysqlAdapter(options: MysqlOptions): DatabaseAdapter {
  const exec = options.exec ?? execProcess;
  const statement = async (name: string, sql: (name: string) => string) => {
    // The name goes into a statement, so only identifier characters may reach it.
    if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new Error(`invalid database name "${name}".`);
    const outcome = await exec(options.client, [...(options.args ?? []), "-e", sql(name)], options.timeoutMs);
    if (outcome.spawnError) throw new Error(`could not start ${options.client}: ${outcome.spawnError}`);
    if (outcome.timedOut) throw new Error(`${options.client} timed out after ${Math.round(options.timeoutMs / 1000)}s.`);
    if (outcome.exitCode !== 0) throw new Error(`${options.client} failed: ${(outcome.stderr || outcome.stdout).trim()}`);
  };
  return {
    create: ({ name }) => statement(name, (n) => `CREATE DATABASE IF NOT EXISTS \`${n}\``),
    drop: ({ name }) => statement(name, (n) => `DROP DATABASE IF EXISTS \`${n}\``),
  };
}
