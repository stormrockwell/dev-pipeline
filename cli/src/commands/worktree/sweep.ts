import { existsSync, realpathSync } from "node:fs";
import { run } from "../check/exec.ts";
import { Refused } from "./context.ts";
import type { Context } from "./context.ts";
import { git, gitOk } from "./git.ts";
import { listRecords } from "./store.ts";

/**
 * What the sweep did with one worktree
 */
export interface SweepRow {
  path: string;
  branch: string | null;
  removed: boolean;
  // The merged pull request, when one was found at the branch's tip.
  pr: number | null;
  reason: string;
}

export interface SweepResult {
  // The primary checkout's head after a pull, or null when it did not pull.
  pulled: string | null;
  rows: SweepRow[];
}

/**
 * Finds the merged pull request whose head is a branch's tip, or null when none is
 */
export type MergedLookup = (branch: string, tip: string) => Promise<number | null>;

interface Listed {
  path: string;
  branch: string | null;
  locked: boolean;
}

/**
 * The repo's worktrees from `git worktree list --porcelain`, the primary checkout first
 */
function parseList(listing: string): Listed[] {
  return listing
    .split("\n\n")
    .map((block) => block.split("\n"))
    .filter((lines) => lines[0]?.startsWith("worktree "))
    .map((lines) => {
      const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length) ?? null;
      return {
        path: lines[0]!.slice("worktree ".length),
        branch: branch === null ? null : branch.replace(/^refs\/heads\//, ""),
        locked: lines.some((line) => line === "locked" || line.startsWith("locked ")),
      };
    });
}

const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);

/**
 * Asks GitHub for a merged pull request from a branch, through the gh CLI
 *
 * Only a pull request whose head commit is the branch's tip counts, so a commit made after the
 * merge keeps the branch.
 */
export function githubMerged(cwd: string, timeoutMs: number): MergedLookup {
  return async (branch, tip) => {
    const outcome = await run("gh", ["pr", "list", "--head", branch, "--state", "merged", "--json", "number,headRefOid", "--limit", "20"], cwd, timeoutMs);
    if (outcome.spawnError) throw new Error(`could not start gh: ${outcome.spawnError}`);
    if (outcome.exitCode !== 0) throw new Error(`gh pr list failed: ${(outcome.stderr || outcome.stdout).trim()}`);
    const prs = JSON.parse(outcome.stdout || "[]") as { number: number; headRefOid: string }[];
    return prs.find((pr) => pr.headRefOid === tip)?.number ?? null;
  };
}

/**
 * Removes each worktree whose pull request merged and that holds no uncommitted work, with its branch
 *
 * Every check runs before anything changes, and a worktree that fails one stays with the reason.
 * A worktree that `pipeline worktree create` made is left to `teardown`, which also frees its
 * database and ports. `git worktree remove` runs without --force, so git refuses anything it
 * would lose too.
 */
export async function sweepWorktrees(ctx: Context, merged: MergedLookup, options: { pull?: boolean; dryRun?: boolean } = {}): Promise<SweepResult> {
  let pulled: string | null = null;
  if (options.pull && !options.dryRun) {
    const pull = await git(ctx.primary, ["pull", "-q", "--ff-only"], ctx.timeoutMs);
    if (!pull.ok) throw new Refused(`could not fast-forward the primary checkout: ${(pull.stderr || pull.stdout).trim()}`);
    pulled = await gitOk(ctx.primary, ["log", "--oneline", "-1"], ctx.timeoutMs);
  }

  const managed = new Map(listRecords(ctx.stateDir).map((record) => [real(record.path), record.name]));
  const rows: SweepRow[] = [];
  for (const listed of parseList(await gitOk(ctx.primary, ["worktree", "list", "--porcelain"], ctx.timeoutMs)).slice(1)) {
    const row = (removed: boolean, reason: string, pr: number | null = null) => rows.push({ path: listed.path, branch: listed.branch, removed, pr, reason });
    const name = managed.get(real(listed.path));
    if (name !== undefined) {
      row(false, `made by pipeline worktree create, so run pipeline worktree teardown ${name}`);
      continue;
    }
    if (listed.branch === null) {
      row(false, "detached HEAD, so no pull request to check");
      continue;
    }
    if (listed.locked) {
      row(false, "locked");
      continue;
    }
    if (!existsSync(listed.path)) {
      row(false, "its folder is gone, so git worktree prune clears it");
      continue;
    }
    const tip = await gitOk(ctx.primary, ["rev-parse", `refs/heads/${listed.branch}`], ctx.timeoutMs);
    const pr = await merged(listed.branch, tip);
    if (pr === null) {
      row(false, "no merged pull request at its tip");
      continue;
    }
    if ((await gitOk(listed.path, ["status", "--porcelain"], ctx.timeoutMs)) !== "") {
      row(false, `pull request #${pr} merged, but it has uncommitted work`, pr);
      continue;
    }
    if (options.dryRun) {
      row(false, `pull request #${pr} merged, so a sweep removes it`, pr);
      continue;
    }
    await gitOk(ctx.primary, ["worktree", "remove", listed.path], ctx.timeoutMs);
    await gitOk(ctx.primary, ["branch", "-D", listed.branch], ctx.timeoutMs);
    row(true, `pull request #${pr} merged`, pr);
  }
  return { pulled, rows };
}

/**
 * The sweep as a line per worktree
 */
export function renderSweep(result: SweepResult): string {
  const lines = result.pulled === null ? [] : [`Pulled the primary checkout to ${result.pulled}.`];
  if (result.rows.length === 0) lines.push("No worktrees beside the primary checkout.");
  for (const row of result.rows) lines.push(`${row.removed ? "Removed" : "Kept"} ${row.path}${row.branch ? ` (${row.branch})` : ""}: ${row.reason}.`);
  return lines.join("\n");
}
