import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type Entry, gateResults, type GateResult, lastTask, rounds } from "../../ledger/ledger.ts";
import { reviews } from "../../run/efficiency.ts";
import { totalTokens } from "../../run/log.ts";
import { duration, type RunSummary } from "../../run/summary.ts";
import { readMerged, roundDir } from "../../review/state.ts";
import type { Status } from "../task-check/checks.ts";
import type { Plan } from "../schedule/plan.ts";

export const RECORD_VERSION = 2;

/**
 * The record a PR body carries for the compounder
 *
 * A field with nothing to report is left out, so a record stays small. The model behind each role
 * is the model on `cost.main` and on each dispatch.
 *
 * TODO: these fields of the PR record in STRATEGY.md have no source yet, so the record leaves them out:
 * - API-priced cost per stage and role, from a price table the CLI does not carry. Tokens stand in.
 * - Tokens per stage, from stage events on each dispatch, which the run log does not join.
 * - Reopened findings, from a finding id that merge marks fixed and a later round reports again.
 * - What raised a task's tier or zones after classification, from a ledger entry `pipeline classify` would write.
 * - Time waiting on a human split into the work order and approval, from the stage each wait falls in.
 * - Work order edits and `Ask:` answers, from ledger entries the work order skill would write.
 * - Tests added, from the task's diff of test files at task-check.
 */
export interface GateRecord {
  version: typeof RECORD_VERSION;
  work: string;
  title: string;
  pr: string | null;
  tasks: {
    id: string;
    title: string;
    tier: string;
    zones: string[];
    status: Status | null;
    branch: string | null;
    commits: string | null;
    rounds: number;
    // Every BLOCKED or NEEDS_CONTEXT report the task gave on the way, with its cause.
    stuck?: { status: Status; cause: string }[];
  }[];
  // A gate that judged one commit, as security does, names it.
  gates: { task: string; gate: string; result: GateResult | "pending"; note: string | null; head?: string }[];
  // Waived findings, each with the reason the human reviewer reads.
  accepted: { task: string; gate: string; finding: string; reason: string }[];
  findings: { opened: number; fixed: number; accepted: number; overruled: number; capHits: number };
  rulings: { task: string | null; decided: string; why: string; cost: string }[];
  cost: {
    tokens: number;
    main: { model: string | null; turns: number; tokens: number };
    dispatches: { type: string; model: string | null; task: string | null; turns: number; tokens: number }[];
  };
  stages: { name: string; ms: number }[];
  waits: { count: number; ms: number };
  sessions: number;
  // The plugin version that built the work, absent when the CLI runs outside a plugin checkout.
  pipeline?: string;
  // Each review round, with its findings by reviewer and tag when merge counted them.
  rounds?: { task: string; round: number; scope: "full" | "fix"; opened: number; fixed: number; by?: Record<string, { opened: number; fixed: number }> }[];
  // Failed commands in the sessions that ran the work, and how many passed on an identical rerun.
  retries?: { failed: number; retried: number; unchanged: number };
  // Sessions whose route changed, each as the routes in order.
  redirects?: string[][];
}

/**
 * What the run logs of the work add up to, beyond the summary
 */
export interface RunTelemetry {
  summary: RunSummary;
  retries: { failed: number; retried: number; unchanged: number };
  redirects: string[][];
}

/**
 * The plugin's version from its manifest beside the CLI, or null when the CLI was copied out of the plugin
 */
export function pipelineVersion(): string | null {
  const manifest = fileURLToPath(new URL("../../../../plugin/.claude-plugin/plugin.json", import.meta.url));
  if (!existsSync(manifest)) return null;
  try {
    const version = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * A planned gate's result, from the ledger, or for TDD from the task's passing check
 */
function gateResult(gate: string, entries: Entry[], task: string): { result: GateResult | "pending"; note: string | null; head?: string } {
  const recorded = gateResults(entries, task).get(gate);
  if (recorded) return { result: recorded.result, note: recorded.note, ...(recorded.head ? { head: recorded.head } : {}) };
  if (!gate.startsWith("TDD")) return { result: "pending", note: null };
  const settled = lastTask(entries, task);
  if (settled?.evidence === "red then green") return { result: "pass", note: "red then green" };
  if (settled?.evidence.startsWith("TDD not required")) return { result: "skip", note: settled.evidence.replace(/^TDD not required: /, "") };
  return { result: "pending", note: null };
}

/**
 * Each review round of the tasks, with the reviewer and tag counts merge wrote beside it
 */
function roundRows(workOrder: string, entries: Entry[], ids: string[]): NonNullable<GateRecord["rounds"]> {
  return ids.flatMap((task) =>
    [...rounds(entries, task).values()]
      .sort((a, b) => a.round - b.round)
      .map((entry) => {
        const by = readMerged(roundDir(workOrder, task, entry.round))?.byReviewer;
        return { task, round: entry.round, scope: entry.scope, opened: entry.opened, fixed: entry.fixed, ...(by && Object.keys(by).length > 0 ? { by } : {}) };
      }),
  );
}

/**
 * The gate record of a work order, or of one of its PRs
 *
 * Gates come from the plan's tiers, and results, waived findings and review rounds from the
 * ledger. Spend comes from the run logs of the sessions that touched the work. The main session's
 * spend covers each such session whole, so a session that also worked on something else counts
 * in full, and so do its retries and redirects.
 */
export function buildRecord(workOrder: string, plan: Plan, entries: Entry[], runs: RunTelemetry | null, pr: string | null, version: string | null = pipelineVersion()): GateRecord {
  const prTasks = pr === null ? null : (plan.prs.find((entry) => entry.name === pr)?.tasks ?? []);
  const tasks = plan.tasks.filter((task) => prTasks === null || prTasks.includes(task.id));
  const ids = tasks.map((task) => task.id);
  const work = basename(dirname(workOrder));

  const gates: GateRecord["gates"] = [];
  for (const task of tasks) {
    for (const gate of task.gates) gates.push({ task: task.id, gate, ...gateResult(gate, entries, task.id) });
    for (const [gate, entry] of gateResults(entries, task.id)) {
      if (!task.gates.includes(gate)) gates.push({ task: task.id, gate, result: entry.result, note: entry.note, ...(entry.head ? { head: entry.head } : {}) });
    }
  }

  const dispatches = (runs?.summary.dispatches ?? [])
    .filter((dispatch) => prTasks === null || dispatch.task === null || ids.includes(dispatch.task))
    .map((dispatch) => ({ type: dispatch.type, model: dispatch.model, task: dispatch.task, turns: dispatch.turns, tokens: totalTokens(dispatch.tokens) }));
  const main = runs ? { model: runs.summary.main.model, turns: runs.summary.main.turns, tokens: totalTokens(runs.summary.main.tokens) } : { model: null, turns: 0, tokens: 0 };

  const accepted = entries
    .filter((entry): entry is Extract<Entry, { kind: "accepted" }> => entry.kind === "accepted" && ids.includes(entry.task))
    .map(({ task, gate, finding, reason }) => ({ task, gate, finding, reason }));
  const reviewRounds = ids.flatMap((id) => [...rounds(entries, id).values()]);
  const mine = entries.filter((entry) => !("task" in entry) || entry.task === null || ids.includes(entry.task));
  const roundList = roundRows(workOrder, entries, ids);
  const retried = runs && runs.retries.failed > 0 ? runs.retries : null;
  const redirects = runs?.redirects ?? [];

  return {
    version: RECORD_VERSION,
    work,
    title: plan.title,
    pr,
    tasks: tasks.map((task) => {
      const settled = lastTask(entries, task.id);
      const stuck = entries
        .filter((entry): entry is Extract<Entry, { kind: "task" }> => entry.kind === "task" && entry.task === task.id && (entry.status === "BLOCKED" || entry.status === "NEEDS_CONTEXT"))
        .map((entry) => ({ status: entry.status, cause: entry.evidence }));
      return {
        id: task.id,
        title: task.title,
        tier: task.tier,
        zones: task.zones,
        status: settled?.status ?? null,
        branch: settled?.branch ?? null,
        commits: settled && settled.base !== settled.head ? `${settled.base.slice(0, 12)}..${settled.head.slice(0, 12)}` : null,
        rounds: rounds(entries, task.id).size,
        ...(stuck.length > 0 ? { stuck } : {}),
      };
    }),
    gates,
    accepted,
    findings: {
      opened: reviewRounds.reduce((sum, round) => sum + round.opened, 0),
      fixed: reviewRounds.reduce((sum, round) => sum + round.fixed, 0),
      accepted: accepted.length,
      overruled: accepted.filter((entry) => entry.reason.startsWith("overruled by ")).length,
      capHits: reviews([{ work, entries: mine }]).filter((row) => row.capHit).length,
    },
    rulings: entries
      .filter((entry): entry is Extract<Entry, { kind: "ruling" }> => entry.kind === "ruling")
      .filter((entry) => prTasks === null || entry.task === null || ids.includes(entry.task))
      .map(({ task, decided, why, cost }) => ({ task, decided, why, cost })),
    cost: { tokens: main.tokens + dispatches.reduce((sum, dispatch) => sum + dispatch.tokens, 0), main, dispatches },
    stages: runs?.summary.stages ?? [],
    waits: runs?.summary.waits ?? { count: 0, ms: 0 },
    sessions: runs?.summary.sessions.length ?? 0,
    ...(version !== null ? { pipeline: version } : {}),
    ...(roundList.length > 0 ? { rounds: roundList } : {}),
    ...(retried ? { retries: { failed: retried.failed, retried: retried.retried, unchanged: retried.unchanged } } : {}),
    ...(redirects.length > 0 ? { redirects } : {}),
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
 * Parses the record back out of a PR body, or null when the body has none or it no longer parses
 *
 * Anyone with write access can edit a PR body, and GitHub saves a body edited in the browser with
 * CRLF line ends.
 */
export function parseHiddenComment(body: string): GateRecord | null {
  const match = /<!-- pipeline:gate-record\r?\n([\s\S]*?)\r?\n-->/.exec(body);
  if (!match) return null;
  try {
    const record = JSON.parse(match[1]!) as GateRecord;
    return typeof record === "object" && record !== null && typeof record.version === "number" ? record : null;
  } catch {
    return null;
  }
}

/**
 * A token count in thousands
 */
function k(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/**
 * A table cell's text, with the characters that would break the row escaped
 */
function cell(text: string): string {
  return text.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

/**
 * The collapsed stats table a PR body shows, generated from the record
 *
 * It names numbers only, so it adds no prose a reviewer has to read and the body's word count skips it.
 */
export function statsTable(record: GateRecord): string {
  const rows: [string, string][] = [];
  if (record.pipeline) rows.push(["Pipeline", record.pipeline]);
  rows.push(["Tasks", record.tasks.map((task) => `${task.id} ${task.tier}${task.zones.length > 0 ? ` (${task.zones.join(", ")})` : ""}`).join(", ")]);
  const rounds = record.tasks.filter((task) => task.rounds > 0).map((task) => `task ${task.id}: ${task.rounds}`);
  if (rounds.length > 0) rows.push(["Review rounds", `${rounds.join(", ")}${record.findings.capHits > 0 ? `, ${record.findings.capHits} at the cap` : ""}`]);
  if (record.findings.opened > 0) rows.push(["Findings", `${record.findings.opened} opened, ${record.findings.fixed} fixed, ${record.findings.accepted} waived${record.findings.overruled > 0 ? ` (${record.findings.overruled} overruled)` : ""}`]);
  const by = new Map<string, { opened: number; fixed: number }>();
  for (const round of record.rounds ?? []) {
    for (const [key, counts] of Object.entries(round.by ?? {})) {
      const row = by.get(key) ?? { opened: 0, fixed: 0 };
      row.opened += counts.opened;
      row.fixed += counts.fixed;
      by.set(key, row);
    }
  }
  if (by.size > 0) rows.push(["By reviewer", [...by].sort(([a], [b]) => a.localeCompare(b)).map(([key, counts]) => `${key} ${counts.opened}/${counts.fixed}`).join(", ")]);
  const stuck = record.tasks.flatMap((task) => (task.stuck ?? []).map((report) => `task ${task.id} ${report.status}`));
  if (stuck.length > 0) rows.push(["Stopped", stuck.join(", ")]);
  const roles = [`main ${record.cost.main.model ?? "unknown"} ${k(record.cost.main.tokens)}`, ...record.cost.dispatches.map((dispatch) => `${dispatch.type.replace(/^dev-pipeline:/, "")}${dispatch.task ? ` ${dispatch.task}` : ""} ${dispatch.model ?? "unknown"} ${k(dispatch.tokens)}`)];
  rows.push(["Tokens", `${k(record.cost.tokens)}: ${roles.join(", ")}`]);
  if (record.stages.length > 0) rows.push(["Stages", record.stages.map((stage) => `${stage.name} ${duration(stage.ms)}`).join(", ")]);
  rows.push(["Waits", `${record.waits.count}, ${duration(record.waits.ms)}`]);
  if (record.retries) rows.push(["Retries", `${record.retries.failed} failed, ${record.retries.retried} retried, ${record.retries.unchanged} passed unchanged`]);
  if (record.redirects) rows.push(["Redirects", record.redirects.map((routes) => routes.join(" to ")).join(", ")]);
  return ["<details><summary>Pipeline stats</summary>", "", "| Stat | Value |", "|---|---|", ...rows.map(([name, value]) => `| ${name} | ${cell(value)} |`), "", "</details>"].join("\n");
}
