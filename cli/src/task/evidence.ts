import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { taskPaths } from "./record.ts";

export type Phase = "red" | "green";

/**
 * One recorded test run
 *
 * `tree` is the working tree's id when the command ran, so a check can tell whether the run
 * tested the code that was later committed.
 */
export interface Run {
  phase: Phase;
  command: string[];
  exit: number | null;
  signal: string | null;
  timedOut: boolean;
  ok: boolean;
  head: string;
  tree: string;
  tail: string;
  at: string;
}

/**
 * Appends a run to the task's evidence log
 */
export function appendRun(worktree: string, run: Run): void {
  appendFileSync(taskPaths(worktree).evidence, `${JSON.stringify(run)}\n`);
}

/**
 * Every run recorded for the task, oldest first
 */
export function readRuns(worktree: string): Run[] {
  const path = taskPaths(worktree).evidence;
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Run);
}
