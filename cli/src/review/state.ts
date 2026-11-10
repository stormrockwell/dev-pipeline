import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Finding, Reviewer } from "./findings.ts";

export type Scope = "full" | "fix";

/**
 * A review round as `pipeline review start` opened it
 *
 * `from` is where the round's diff starts: the task's base in a full round, and the head the last
 * round reviewed in a fix round. `fixLines` holds, per file, the lines the fix diff added at HEAD,
 * so merge can tell a finding on the fix from one on code the fix never touched.
 */
export interface Round {
  task: string;
  round: number;
  scope: Scope;
  worktree: string;
  base: string;
  from: string;
  startHead: string;
  reviewers: Reviewer[];
  reasons: Partial<Record<Reviewer, string>>;
  skipped: { gate: string; reason: string }[];
  zoneFiles: string[];
  fixLines: Record<string, number[]> | null;
  overruled: { finding: string; over: string }[];
  dismissed: string[];
}

/**
 * What merge made of a round
 */
export interface Merged {
  head: string;
  accepted: Finding[];
  backlog: (Finding & { why: string })[];
  duplicates: { dropped: string; kept: string }[];
  contests: { high: string; low: string }[];
  fixed: string[];
  opened: number;
}

/**
 * The review folder of one task, beside the work order
 */
export function taskReviewDir(workOrder: string, task: string): string {
  return join(dirname(workOrder), "review", `task-${task}`);
}

/**
 * The folder of one round
 */
export function roundDir(workOrder: string, task: string, round: number): string {
  return join(taskReviewDir(workOrder, task), `round-${round}`);
}

/**
 * Paths of a round's files
 */
export function roundPaths(dir: string) {
  return {
    dir,
    state: join(dir, "round.json"),
    merged: join(dir, "merged.json"),
    fixList: join(dir, "fix-list.md"),
    package: (reviewer: Reviewer) => join(dir, `package-${reviewer}.md`),
    findings: (reviewer: Reviewer) => join(dir, `findings-${reviewer}.json`),
    reply: (reviewer: Reviewer) => join(dir, `reply-${reviewer}.md`),
    blocks: (reviewer: Reviewer) => join(dir, `stop-blocks-${reviewer}`),
  };
}

/**
 * The numbers of a task's rounds, lowest first
 */
export function roundNumbers(workOrder: string, task: string): number[] {
  const dir = taskReviewDir(workOrder, task);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => /^round-(\d+)$/.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * Reads a round's state
 */
export function readRound(dir: string): Round {
  return JSON.parse(readFileSync(roundPaths(dir).state, "utf8")) as Round;
}

/**
 * Writes a round's state
 */
export function writeRound(dir: string, round: Round): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(roundPaths(dir).state, `${JSON.stringify(round, null, 2)}\n`);
}

/**
 * Reads what merge made of a round, or null before the round merged
 */
export function readMerged(dir: string): Merged | null {
  const path = roundPaths(dir).merged;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Merged) : null;
}

/**
 * The findings still open after the last merged round before a given one, which that round's reviewers check
 */
export function openFindings(workOrder: string, task: string, before = Infinity): Finding[] {
  const merged = roundNumbers(workOrder, task)
    .filter((round) => round < before)
    .map((round) => readMerged(roundDir(workOrder, task, round)))
    .filter((value): value is Merged => value !== null)
    .at(-1);
  return merged?.accepted ?? [];
}
