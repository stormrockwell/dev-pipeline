import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Refused } from "./context.ts";
import type { Context } from "./context.ts";
import { databaseName } from "./database.ts";
import { cloneDependencies, defaultInstalls } from "./deps.ts";
import { gitOk } from "./git.ts";
import { withLock } from "./lock.ts";
import { allocatePorts } from "./ports.ts";
import { deleteRecord, listRecords, readRecord, registryLock, writeRecord } from "./store.ts";
import type { WorktreeRecord } from "./store.ts";

export interface CreateOptions {
  name: string;
  // The ref the new branch starts from. Defaults to the integration checkout's HEAD.
  base?: string;
  branch?: string;
  path?: string;
  // Allow npm ci or composer install when the primary checkout has no directory to clone.
  install?: boolean;
}

const namePattern = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function validateName(name: string): void {
  if (!namePattern.test(name)) {
    throw new Refused(`invalid worktree name "${name}". Use lowercase letters, digits, "-" and "_", starting with a letter or digit.`);
  }
}

// The info/exclude file keeps generated files out of git status without editing a tracked .gitignore.
function excludePatterns(file: string, patterns: string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const have = new Set(existing.split("\n"));
  const missing = patterns.filter((pattern) => !have.has(pattern));
  if (missing.length === 0) return;
  appendFileSync(file, `${existing === "" || existing.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`);
}

function envFileContent(record: WorktreeRecord, ctx: Context): string {
  const { nameVar, dirVar, kind } = ctx.config.database;
  const lines = [
    "# Written by pipeline worktree for this worktree only. Do not commit.",
    `${nameVar}="${record.database.name}"`,
    ...(kind === "sqlite-dir" ? [`${dirVar}="${record.database.dir}"`] : []),
    `PIPELINE_PORT_BASE="${record.ports.base}"`,
    `PIPELINE_PORT_END="${record.ports.end}"`,
    `PORT="${record.ports.base}"`,
  ];
  return `${lines.join("\n")}\n`;
}

async function rollback(ctx: Context, record: WorktreeRecord): Promise<void> {
  const quietly = async (step: () => Promise<unknown>) => {
    try {
      await step();
    } catch {
      // Rollback keeps going so one stuck step does not strand the others.
    }
  };
  await quietly(() => ctx.database.drop(record.database));
  await quietly(() => gitOk(ctx.primary, ["worktree", "remove", "--force", record.path], ctx.timeoutMs));
  await quietly(() => gitOk(ctx.primary, ["branch", "-D", record.branch], ctx.timeoutMs));
  deleteRecord(ctx.stateDir, record.name);
}

export async function createWorktree(ctx: Context, options: CreateOptions): Promise<WorktreeRecord> {
  validateName(options.name);
  const branch = options.branch ?? `wt/${options.name}`;
  const path = options.path ?? join(dirname(ctx.primary), `${ctx.repoName}-wt`, options.name);
  const base = options.base ?? "HEAD";
  const { database } = ctx.config;

  // Port choice, the worktree add and the record write share one lock so two creations never pick the same range.
  const record = await withLock(registryLock(ctx.stateDir), { timeoutMs: ctx.lockTimeoutMs }, async () => {
    if (readRecord(ctx.stateDir, options.name) || existsSync(path)) {
      throw new Refused(`worktree ${options.name} already exists at ${path}.`);
    }
    const ports = await allocatePorts(
      listRecords(ctx.stateDir).map((other) => other.ports),
      ctx.config.ports,
      ctx.isPortFree,
    );
    await gitOk(ctx.primary, ["worktree", "add", "-b", branch, path, base], ctx.timeoutMs);
    const created: WorktreeRecord = {
      name: options.name,
      branch,
      base,
      path,
      database: {
        name: databaseName(ctx.repoName, options.name, path),
        dir: join(path, ".pipeline", "test-db"),
        kind: database.kind,
      },
      ports,
      clones: [],
    };
    writeRecord(ctx.stateDir, created);
    excludePatterns(ctx.excludeFile, [
      `/${database.envFile}`,
      "/.pipeline/test-db/",
      ...ctx.config.clone.map((dir) => `/${dir}/`),
    ]);
    return created;
  });

  try {
    record.clones = await cloneDependencies({
      source: ctx.primary,
      dest: record.path,
      dirs: ctx.config.clone,
      timeoutMs: ctx.timeoutMs,
      install: options.install ? defaultInstalls : undefined,
    });
    await ctx.database.create(record.database);
    await ctx.afterDatabase?.();
    writeFileSync(join(record.path, database.envFile), envFileContent(record, ctx));
    writeRecord(ctx.stateDir, record);
  } catch (error) {
    await rollback(ctx, record);
    throw error;
  }
  return record;
}
