import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tier } from "../commands/classify/tier.ts";
import type { Zone } from "../commands/scan-zones/types.ts";
import { repoTop } from "../commands/secrets/git.ts";

export const TASK_DIR = ".pipeline/task";

/**
 * What a briefed task holds, written beside the brief in the task's worktree
 *
 * The record is git-ignored, so nothing in it reaches a commit.
 */
export interface TaskRecord {
  workOrder: string;
  id: string;
  title: string;
  tier: Tier;
  zones: Zone[];
  gates: string[];
  files: string[];
  tdd: { required: boolean; reason: string | null };
  test: string | null;
  base: string;
  worktree: string;
}

/**
 * Paths of a task's files inside its worktree
 */
export function taskPaths(worktree: string) {
  const dir = join(worktree, TASK_DIR);
  return {
    dir,
    record: join(dir, "task.json"),
    brief: join(dir, "brief.md"),
    report: join(dir, "report.md"),
    evidence: join(dir, "evidence.jsonl"),
    blocks: join(dir, "stop-blocks"),
  };
}

/**
 * The worktree whose briefed task holds this directory, or null outside one
 */
export function findTask(start: string): string | null {
  if (!existsSync(start)) return null;
  const top = repoTop(start);
  return top !== null && existsSync(taskPaths(top).record) ? top : null;
}

/**
 * Reads the record of the task briefed in a worktree
 */
export function readRecord(worktree: string): TaskRecord {
  return JSON.parse(readFileSync(taskPaths(worktree).record, "utf8")) as TaskRecord;
}

/**
 * Writes a task's record into its worktree
 */
export function writeRecord(record: TaskRecord): void {
  const paths = taskPaths(record.worktree);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.record, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Whether a task owns a path, either listed exactly or under a listed folder ending in a slash
 */
export function ownsFile(files: string[], file: string): boolean {
  const path = file.replace(/^\.\//, "");
  return files.some((entry) => {
    const owned = entry.replace(/^\.\//, "");
    return owned === path || (owned.endsWith("/") && path.startsWith(owned));
  });
}
