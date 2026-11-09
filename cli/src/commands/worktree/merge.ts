import { Refused } from "./context.ts";
import type { Context } from "./context.ts";
import { git, gitOk } from "./git.ts";
import { withLock } from "./lock.ts";
import { mergeLock, readRecord } from "./store.ts";

export interface MergeOptions {
  name: string;
  // The integration branch. Defaults to the branch checked out in the primary checkout.
  into?: string;
}

export interface MergeResult {
  name: string;
  branch: string;
  into: string;
  // False when the branch had nothing the integration branch lacked.
  merged: boolean;
  head: string;
}

async function conflictedFiles(cwd: string, timeoutMs: number): Promise<string[]> {
  const listing = await git(cwd, ["diff", "--name-only", "--diff-filter=U"], timeoutMs);
  return listing.stdout.split("\n").filter(Boolean);
}

/**
 * Merges a worktree branch into the integration branch while holding the merge lock. The merge runs in the
 * primary checkout and never forces. A conflict aborts the merge and refuses, so the integration branch keeps its
 * last good state and the developer or orchestrator resolves it in the worktree.
 */
export async function mergeWorktree(ctx: Context, options: MergeOptions): Promise<MergeResult> {
  const record = readRecord(ctx.stateDir, options.name);
  if (!record) throw new Refused(`no worktree named ${options.name}.`);

  const dirty = await gitOk(record.path, ["status", "--porcelain"], ctx.timeoutMs);
  if (dirty) throw new Refused(`worktree ${options.name} has uncommitted changes. Commit them before merging.`);

  return withLock(mergeLock(ctx.stateDir), { timeoutMs: ctx.lockTimeoutMs }, async () => {
    await ctx.inMergeLock?.();

    const current = await gitOk(ctx.primary, ["rev-parse", "--abbrev-ref", "HEAD"], ctx.timeoutMs);
    const into = options.into ?? current;
    if (into === "HEAD") throw new Refused("the integration checkout has a detached HEAD. Check out the integration branch first.");
    if (current !== into) throw new Refused(`the integration checkout is on ${current}, not ${into}.`);

    // The status check runs under the lock, so an earlier merge in the queue has already finished.
    const primaryDirty = await gitOk(ctx.primary, ["status", "--porcelain"], ctx.timeoutMs);
    if (primaryDirty) throw new Refused("the integration checkout has uncommitted changes. Commit or stash them first.");

    const contained = await git(ctx.primary, ["merge-base", "--is-ancestor", record.branch, "HEAD"], ctx.timeoutMs);
    if (contained.ok) {
      return { name: record.name, branch: record.branch, into, merged: false, head: await gitOk(ctx.primary, ["rev-parse", "HEAD"], ctx.timeoutMs) };
    }

    const attempt = await git(ctx.primary, ["merge", "--no-ff", "--no-edit", "-m", `merge ${record.branch}`, record.branch], ctx.timeoutMs);
    if (!attempt.ok) {
      const files = await conflictedFiles(ctx.primary, ctx.timeoutMs);
      await git(ctx.primary, ["merge", "--abort"], ctx.timeoutMs);
      if (files.length > 0) {
        throw new Refused(`merge refused, conflict in ${files.join(", ")}. ${into} is unchanged. Resolve it in the worktree and merge again.`);
      }
      throw new Refused(`merge refused, git failed: ${(attempt.stderr || attempt.stdout).trim()}`);
    }
    return { name: record.name, branch: record.branch, into, merged: true, head: await gitOk(ctx.primary, ["rev-parse", "HEAD"], ctx.timeoutMs) };
  });
}
