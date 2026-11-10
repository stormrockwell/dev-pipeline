import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Status } from "../commands/task-check/checks.ts";

export type GateResult = "pass" | "fail" | "skip";

export type Entry =
  | { kind: "task"; at: string; task: string; status: Status; branch: string | null; base: string; head: string; evidence: string }
  | { kind: "ruling"; at: string; task: string | null; decided: string; why: string; cost: string }
  | { kind: "gate"; at: string; task: string; gate: string; result: GateResult; note: string | null };

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
 */
export function appendEntry(workOrder: string, entry: Entry): void {
  if (entry.kind === "task") {
    const last = lastTask(readLedger(workOrder), entry.task);
    if (last && last.status === entry.status && last.head === entry.head) return;
  }
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
