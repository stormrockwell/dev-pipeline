import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Status } from "../commands/task-check/checks.ts";

export type GateResult = "pass" | "fail" | "skip";

export type Entry =
  | { kind: "task"; at: string; task: string; status: Status; branch: string | null; base: string; head: string; evidence: string }
  | { kind: "ruling"; at: string; task: string | null; decided: string; why: string; cost: string }
  | { kind: "gate"; at: string; task: string; gate: string; result: GateResult; note: string | null }
  // A waived finding, with the reason the human reviewer sees.
  | { kind: "accepted"; at: string; task: string; gate: string; finding: string; reason: string }
  // One merged review round, with the findings it opened and the open ones the fix resolved.
  | { kind: "round"; at: string; task: string; round: number; scope: "full" | "fix"; head: string; opened: number; fixed: number };

/**
 * The ledger beside a work order
 *
 * It sits in the git-ignored work folder with the work order, so it outlives a compacted context
 * and any one worktree.
 */
export function ledgerPath(workOrder: string): string {
  return join(dirname(workOrder), "ledger.jsonl");
}

/**
 * Every entry in a work order's ledger, oldest first
 */
export function readLedger(workOrder: string): Entry[] {
  const path = ledgerPath(workOrder);
  if (!existsSync(path)) return [];
  const entries: Entry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      continue;
    }
  }
  return entries;
}

/**
 * Appends an entry, skipping a task entry that repeats the task's last one
 *
 * The Stop hook and the orchestrator both check a finished task, so the same result arrives twice.
 * A ruling, acceptance or round already recorded is skipped too, because review merge reruns after
 * each overrule.
 */
export function appendEntry(workOrder: string, entry: Entry): void {
  if (entry.kind === "task") {
    const last = lastTask(readLedger(workOrder), entry.task);
    if (last && last.status === entry.status && last.head === entry.head) return;
  }
  if (entry.kind !== "task" && entry.kind !== "gate" && repeats(readLedger(workOrder), entry)) return;
  appendFileSync(ledgerPath(workOrder), `${JSON.stringify(entry)}\n`);
}

/**
 * A task's latest result
 */
export function lastTask(entries: Entry[], task: string): Extract<Entry, { kind: "task" }> | undefined {
  return entries.filter((entry): entry is Extract<Entry, { kind: "task" }> => entry.kind === "task" && entry.task === task).at(-1);
}

/**
 * Each gate's latest result for a task, keyed by gate name
 */
export function gateResults(entries: Entry[], task: string): Map<string, Extract<Entry, { kind: "gate" }>> {
  const results = new Map<string, Extract<Entry, { kind: "gate" }>>();
  for (const entry of entries) if (entry.kind === "gate" && entry.task === task) results.set(entry.gate, entry);
  return results;
}

/**
 * Whether a task's latest result means its work is done
 */
export function complete(entry: Extract<Entry, { kind: "task" }> | undefined): boolean {
  return entry?.status === "DONE" || entry?.status === "DONE_WITH_CONCERNS";
}

/**
 * Whether the ledger already holds an entry with the same content, the time aside
 */
function repeats(entries: Entry[], entry: Entry): boolean {
  const key = (value: Entry) => JSON.stringify({ ...value, at: undefined });
  return entries.some((existing) => key(existing) === key(entry));
}

/**
 * Each task's latest record of each review round, keyed by round number
 */
export function rounds(entries: Entry[], task: string): Map<number, Extract<Entry, { kind: "round" }>> {
  const found = new Map<number, Extract<Entry, { kind: "round" }>>();
  for (const entry of entries) if (entry.kind === "round" && entry.task === task) found.set(entry.round, entry);
  return found;
}
