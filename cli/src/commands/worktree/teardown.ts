import { existsSync } from "node:fs";
import { Refused } from "./context.ts";
import type { Context } from "./context.ts";
import { git, gitOk } from "./git.ts";
import { withLock } from "./lock.ts";
import { deleteRecord, readRecord, registryLock } from "./store.ts";
import type { WorktreeRecord } from "./store.ts";

export interface TeardownResult {
  name: string;
  removed: boolean;
}

/**
 * Counts commits on the branch that no remote holds and the integration branch lacks. Work already merged
 * is safe in the integration branch, so a worktree whose merge went through can be removed before the push.
 */
async function unpushedCommits(ctx: Context, record: WorktreeRecord): Promise<number> {
  const current = await git(ctx.primary, ["rev-parse", "--abbrev-ref", "HEAD"], ctx.timeoutMs);
  const integration = current.ok && current.stdout.trim() !== "HEAD" ? [current.stdout.trim()] : [];
  const count = await gitOk(ctx.primary, ["rev-list", "--count", record.branch, "--not", "--remotes", ...integration], ctx.timeoutMs);
  return Number(count);
}

/**
 * Removes a worktree only when no work would be lost. The checks run first and change nothing, so a refusal
 * leaves the worktree, database and ports as they were. Once they pass, every later step is safe to repeat.
 */
export async function teardownWorktree(ctx: Context, options: { name: string }): Promise<TeardownResult> {
  const record = readRecord(ctx.stateDir, options.name);
  if (!record) throw new Refused(`no worktree named ${options.name}.`);

  if (existsSync(record.path)) {
    const dirty = await gitOk(record.path, ["status", "--porcelain"], ctx.timeoutMs);
    if (dirty) throw new Refused(`worktree ${options.name} has uncommitted changes. Commit or discard them first.`);
    const unpushed = await unpushedCommits(ctx, record);
    if (unpushed > 0) {
      throw new Refused(`worktree ${options.name} has ${unpushed} unpushed commits. Push the branch or merge it first.`);
    }
    // Without --force, git also refuses on anything it considers unsaved.
    await gitOk(ctx.primary, ["worktree", "remove", record.path], ctx.timeoutMs);
  } else {
    await gitOk(ctx.primary, ["worktree", "prune"], ctx.timeoutMs);
  }

  await ctx.database.drop(record.database);
  // The record holds the port range, so deleting it last keeps the range reserved until cleanup finishes.
  await withLock(registryLock(ctx.stateDir), { timeoutMs: ctx.lockTimeoutMs }, async () => deleteRecord(ctx.stateDir, record.name));
  return { name: record.name, removed: true };
}
