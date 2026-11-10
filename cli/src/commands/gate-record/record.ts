import { basename, dirname } from "node:path";
import { type Entry, gateResults, type GateResult, lastTask } from "../../ledger/ledger.ts";
import { totalTokens } from "../../run/log.ts";
import type { RunSummary } from "../../run/summary.ts";
import type { Status } from "../task-check/checks.ts";
import type { Plan } from "../schedule/plan.ts";

export interface GateRecord {
  version: 1;
  work: string;
  title: string;
  pr: string | null;
  tasks: { id: string; title: string; tier: string; zones: string[]; status: Status | null; branch: string | null; commits: string | null }[];
  gates: { task: string; gate: string; result: GateResult | "pending"; note: string | null }[];
  rulings: { task: string | null; decided: string; why: string; cost: string }[];
  cost: {
    tokens: number;
    main: { model: string | null; turns: number; tokens: number };
    dispatches: { type: string; model: string | null; task: string | null; turns: number; tokens: number }[];
  };
  stages: { name: string; ms: number }[];
  waits: { count: number; ms: number };
  sessions: number;
}

/**
 * A planned gate's result, from the ledger, or for TDD from the task's passing check
 */
function gateResult(gate: string, entries: Entry[], task: string): { result: GateResult | "pending"; note: string | null } {
  const recorded = gateResults(entries, task).get(gate);
  if (recorded) return { result: recorded.result, note: recorded.note };
  if (!gate.startsWith("TDD")) return { result: "pending", note: null };
  const settled = lastTask(entries, task);
  if (settled?.evidence === "red then green") return { result: "pass", note: "red then green" };
  if (settled?.evidence.startsWith("TDD not required")) return { result: "skip", note: settled.evidence.replace(/^TDD not required: /, "") };
  return { result: "pending", note: null };
}

/**
 * The gate record of a work order, or of one of its PRs
 *
 * Gates come from the plan's tiers, results from the ledger, and spend from the run logs of the
 * sessions that touched the work. The main session's spend covers each such session whole, so a
 * session that also worked on something else counts in full.
 */
export function buildRecord(workOrder: string, plan: Plan, entries: Entry[], runs: RunSummary | null, pr: string | null): GateRecord {
  const prTasks = pr === null ? null : (plan.prs.find((entry) => entry.name === pr)?.tasks ?? []);
  const tasks = plan.tasks.filter((task) => prTasks === null || prTasks.includes(task.id));
  const ids = tasks.map((task) => task.id);

  const gates: GateRecord["gates"] = [];
  for (const task of tasks) {
    for (const gate of task.gates) gates.push({ task: task.id, gate, ...gateResult(gate, entries, task.id) });
    for (const [gate, entry] of gateResults(entries, task.id)) {
      if (!task.gates.includes(gate)) gates.push({ task: task.id, gate, result: entry.result, note: entry.note });
    }
  }

  const dispatches = (runs?.dispatches ?? [])
    .filter((dispatch) => prTasks === null || dispatch.task === null || ids.includes(dispatch.task))
    .map((dispatch) => ({ type: dispatch.type, model: dispatch.model, task: dispatch.task, turns: dispatch.turns, tokens: totalTokens(dispatch.tokens) }));
  const main = runs ? { model: runs.main.model, turns: runs.main.turns, tokens: totalTokens(runs.main.tokens) } : { model: null, turns: 0, tokens: 0 };

  return {
    version: 1,
    work: basename(dirname(workOrder)),
    title: plan.title,
    pr,
    tasks: tasks.map((task) => {
      const settled = lastTask(entries, task.id);
      return {
        id: task.id,
        title: task.title,
        tier: task.tier,
        zones: task.zones,
        status: settled?.status ?? null,
        branch: settled?.branch ?? null,
        commits: settled && settled.base !== settled.head ? `${settled.base.slice(0, 12)}..${settled.head.slice(0, 12)}` : null,
      };
    }),
    gates,
    rulings: entries
      .filter((entry): entry is Extract<Entry, { kind: "ruling" }> => entry.kind === "ruling")
      .filter((entry) => prTasks === null || entry.task === null || ids.includes(entry.task))
      .map(({ task, decided, why, cost }) => ({ task, decided, why, cost })),
    cost: { tokens: main.tokens + dispatches.reduce((sum, dispatch) => sum + dispatch.tokens, 0), main, dispatches },
    stages: runs?.stages ?? [],
    waits: runs?.waits ?? { count: 0, ms: 0 },
    sessions: runs?.sessions.length ?? 0,
  };
}

/**
 * The record as an HTML comment for a PR body, hidden from readers and parsed by the compounder
 *
 * A double hyphen inside a string would end the comment early, so it goes out as a JSON escape.
 */
export function hiddenComment(record: GateRecord): string {
  return `<!-- pipeline:gate-record\n${JSON.stringify(record).replaceAll("--", "-\\u002d")}\n-->`;
}

/**
 * Parses the record back out of a PR body
 */
export function parseHiddenComment(body: string): GateRecord | null {
  const match = /<!-- pipeline:gate-record\n([\s\S]*?)\n-->/.exec(body);
  return match ? (JSON.parse(match[1]!) as GateRecord) : null;
}
