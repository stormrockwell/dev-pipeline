import type { Entry } from "../ledger/ledger.ts";
import { MAX_ROUNDS } from "../review/flow.ts";
import { type RunEvent, type RunLog, totalTokens } from "./log.ts";
import { LOOK, type Roots, steps } from "./shape.ts";
import { duration, stages, summarize, waits } from "./summary.ts";
import { transcriptRoutes } from "./transcript.ts";

/**
 * One work order's ledger
 */
export interface Ledger {
  work: string;
  entries: Entry[];
}

/**
 * A run of steps that recurs across streams, with the calls a script in its place would save
 */
export interface Sequence {
  steps: string[];
  count: number;
  streams: number;
  sessions: number;
  saves: number;
}

/**
 * What slowed the pipeline down, as the compounder's efficiency half reads it
 *
 * A stream is the tool calls of one maker in one session: the main thread, or one subagent.
 */
export interface EfficiencyReport {
  sources: { sessions: number; streams: number; calls: number; from: string | null; to: string | null };
  stages: { name: string; runs: number; ms: number; medianMs: number }[];
  waits: { count: number; ms: number; longestMs: number };
  slow: { step: string; calls: number; ms: number; medianMs: number }[];
  reviews: { work: string; task: string; rounds: number; opened: number; fixed: number; capHit: boolean }[];
  sentBack: { type: string; agents: number; returns: number }[];
  retries: { step: string; failed: number; retried: number; recovered: number; unchanged: number }[];
  misroutes: { session: string; routes: string[] }[];
  dispatches: { type: string; model: string | null; count: number; turns: number; tokens: number }[];
  sequences: Sequence[];
  reads: { path: string; streams: number; count: number }[];
}

/**
 * How far the report looks
 *
 * `minStreams` is how many streams a sequence or a file read must recur in to count, `longest` the
 * longest sequence mined, and `top` how many rows each list keeps.
 */
export interface Options {
  roots: Roots;
  minStreams?: number;
  longest?: number;
  top?: number;
  routes?: (log: RunLog) => string[];
}

type Tool = Extract<RunEvent, { kind: "tool" }>;

interface Stream {
  session: string;
  calls: Tool[];
}

// A retry this many calls after the failure still counts as one.
const RETRY_WINDOW = 3;
const EDITS = new Set(["Edit", "Write", "NotebookEdit"]);

const time = (event: RunEvent) => Date.parse(event.at);

/**
 * The middle value, or the mean of the middle two
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/**
 * Each log's tool calls split by who made them, in the order they landed
 */
function streamsOf(logs: RunLog[]): Stream[] {
  const streams = new Map<string, Stream>();
  for (const log of logs) {
    for (const event of [...log.events].sort((a, b) => time(a) - time(b))) {
      if (event.kind !== "tool") continue;
      const key = `${log.session}/${event.agent ?? "main"}`;
      const stream = streams.get(key) ?? { session: log.session, calls: [] };
      stream.calls.push(event);
      streams.set(key, stream);
    }
  }
  return [...streams.values()];
}

/**
 * The first step a call stands for, the one a retry repeats
 */
function headStep(call: Tool, roots: Roots): string {
  return steps(call.tool, call.input, roots)[0] ?? call.tool;
}

/**
 * The steps of a call that a sequence can hold
 *
 * An edit writes content a person or model authored, so no script can stand in for it, and it
 * breaks a sequence. Shell commands that only look at files drop out, so the steps around them join.
 */
function minable(call: Tool, roots: Roots): (string | null)[] {
  if (EDITS.has(call.tool)) return [null];
  return steps(call.tool, call.input, roots).filter((step) => !LOOK.has(step.split(" ")[0]!));
}

/**
 * Runs of steps that recur in at least `minStreams` streams
 *
 * Occurrences inside one stream count without overlap. A run that only ever appears inside a
 * longer recurring run is left out, so each sequence is reported once at its full length. A step
 * repeated back to back counts once, because a retry is not a sequence. A null step is a break no
 * sequence crosses.
 */
export function mineSequences(streams: { session: string; steps: (string | null)[] }[], minStreams = 2, longest = 8): Sequence[] {
  const found = new Map<string, { steps: string[]; count: number; streams: Set<number>; sessions: Set<string>; end: number; last: number }>();
  streams.forEach((stream, id) => {
    const seq = stream.steps.filter((step, index) => step !== stream.steps[index - 1]);
    for (let length = 2; length <= longest; length += 1) {
      for (let start = 0; start + length <= seq.length; start += 1) {
        const window = seq.slice(start, start + length);
        if (window.includes(null) || window.every((step) => step === window[0])) continue;
        const key = window.join("\n");
        const entry = found.get(key) ?? { steps: window as string[], count: 0, streams: new Set<number>(), sessions: new Set<string>(), end: 0, last: -1 };
        if (entry.last === id && start < entry.end) continue;
        entry.count += 1;
        entry.streams.add(id);
        entry.sessions.add(stream.session);
        entry.last = id;
        entry.end = start + length;
        found.set(key, entry);
      }
    }
  });
  const kept = [...found.values()].filter((entry) => entry.streams.size >= minStreams && entry.count >= minStreams);
  // Each run one step shorter than a kept run, with the most times that longer run was seen.
  const inside = new Map<string, number>();
  for (const entry of kept) {
    for (const part of [entry.steps.slice(1), entry.steps.slice(0, -1)]) inside.set(part.join("\n"), Math.max(inside.get(part.join("\n")) ?? 0, entry.count));
  }
  return kept
    .filter((entry) => (inside.get(entry.steps.join("\n")) ?? 0) < entry.count)
    .map((entry) => ({ steps: entry.steps, count: entry.count, streams: entry.streams.size, sessions: entry.sessions.size, saves: entry.count * (entry.steps.length - 1) }))
    .sort((a, b) => b.saves - a.saves || b.steps.length - a.steps.length || a.steps.join().localeCompare(b.steps.join()));
}

/**
 * Failed calls and what followed them
 *
 * A retry is the same step again within a few calls. It recovered when the retry passed, and it
 * passed unchanged when the command was identical and no file was edited between, which is what a
 * flaky test or a shaky environment looks like.
 */
function retries(streams: Stream[], roots: Roots): EfficiencyReport["retries"] {
  const byStep = new Map<string, EfficiencyReport["retries"][number]>();
  for (const { calls } of streams) {
    calls.forEach((call, index) => {
      if (call.ok) return;
      const step = headStep(call, roots);
      const row = byStep.get(step) ?? { step, failed: 0, retried: 0, recovered: 0, unchanged: 0 };
      row.failed += 1;
      const after = calls.slice(index + 1, index + 1 + RETRY_WINDOW);
      const again = after.findIndex((next) => headStep(next, roots) === step);
      if (again !== -1) {
        const retry = after[again]!;
        row.retried += 1;
        if (retry.ok) row.recovered += 1;
        const edited = after.slice(0, again).some((between) => EDITS.has(between.tool));
        if (retry.ok && retry.input === call.input && !edited) row.unchanged += 1;
      }
      byStep.set(step, row);
    });
  }
  return [...byStep.values()].sort((a, b) => b.failed - a.failed || a.step.localeCompare(b.step));
}

/**
 * Review rounds per task from the ledgers, with whether the task hit the round cap
 *
 * A task hit the cap when it ran past it, or when its last allowed round still opened findings.
 */
function reviews(ledgers: Ledger[]): EfficiencyReport["reviews"] {
  const rows: EfficiencyReport["reviews"] = [];
  for (const { work, entries } of ledgers) {
    const tasks = new Map<string, Map<number, Extract<Entry, { kind: "round" }>>>();
    const pastCap = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === "round") tasks.set(entry.task, (tasks.get(entry.task) ?? new Map()).set(entry.round, entry));
      if (entry.kind === "ruling" && entry.task !== null && /past the \d+-round cap/.test(entry.decided)) pastCap.add(entry.task);
    }
    for (const [task, rounds] of tasks) {
      const all = [...rounds.values()];
      const count = Math.max(...rounds.keys());
      const capHit = count > MAX_ROUNDS || pastCap.has(task) || (count === MAX_ROUNDS && rounds.get(count)!.opened > 0);
      rows.push({ work, task, rounds: count, opened: all.reduce((sum, round) => sum + round.opened, 0), fixed: all.reduce((sum, round) => sum + round.fixed, 0), capHit });
    }
  }
  return rows.sort((a, b) => b.rounds - a.rounds || a.work.localeCompare(b.work) || a.task.localeCompare(b.task));
}

/**
 * How often a Stop hook sent each kind of agent back, from the dispatch it records on every stop
 */
function sentBack(logs: RunLog[]): EfficiencyReport["sentBack"] {
  const byType = new Map<string, { agents: Set<string>; stops: number }>();
  for (const log of logs) {
    for (const event of log.events) {
      if (event.kind !== "dispatch") continue;
      const row = byType.get(event.type) ?? { agents: new Set<string>(), stops: 0 };
      row.agents.add(`${log.session}/${event.agent}`);
      row.stops += 1;
      byType.set(event.type, row);
    }
  }
  return [...byType]
    .map(([type, row]) => ({ type, agents: row.agents.size, returns: row.stops - row.agents.size }))
    .filter((row) => row.returns > 0)
    .sort((a, b) => b.returns - a.returns);
}

/**
 * The routes each session named, from the transcript its run log links to
 */
function linkedRoutes(log: RunLog): string[] {
  const session = log.events.find((event) => event.kind === "session" && event.transcript !== null);
  return transcriptRoutes(session?.kind === "session" ? session.transcript : null).map((found) => found.route);
}

/**
 * Sessions whose route changed after the first was named, as when a developer redirects one
 */
function misroutes(logs: RunLog[], routesOf: (log: RunLog) => string[]): EfficiencyReport["misroutes"] {
  return logs.flatMap((log) => {
    const routes = routesOf(log).filter((route, index, all) => route !== all[index - 1]);
    return routes.length > 1 ? [{ session: log.session, routes }] : [];
  });
}

/**
 * Reads the run logs and ledgers for what slowed the pipeline down
 */
export function efficiency(logs: RunLog[], ledgers: Ledger[], options: Options): EfficiencyReport {
  const { roots, minStreams = 2, longest = 8, top = 10 } = options;
  const streams = streamsOf(logs);
  const calls = streams.flatMap((stream) => stream.calls);
  const times = logs.flatMap((log) => log.events.map(time)).filter((at) => !Number.isNaN(at));

  const stageRuns = new Map<string, number[]>();
  const spans: [number, number][] = [];
  for (const log of logs) {
    const events = [...log.events].sort((a, b) => time(a) - time(b));
    const own = waits(events);
    spans.push(...own);
    for (const stage of stages(events, own)) stageRuns.set(stage.name, [...(stageRuns.get(stage.name) ?? []), stage.ms]);
  }

  const slow = new Map<string, number[]>();
  for (const call of calls) {
    if (call.ms === null || ["AskUserQuestion", "Agent", "Task"].includes(call.tool)) continue;
    const step = headStep(call, roots);
    slow.set(step, [...(slow.get(step) ?? []), call.ms]);
  }

  const dispatches = new Map<string, EfficiencyReport["dispatches"][number]>();
  for (const dispatch of summarize(logs).dispatches) {
    const key = `${dispatch.type}\n${dispatch.model}`;
    const row = dispatches.get(key) ?? { type: dispatch.type, model: dispatch.model, count: 0, turns: 0, tokens: 0 };
    row.count += 1;
    row.turns += dispatch.turns;
    row.tokens += totalTokens(dispatch.tokens);
    dispatches.set(key, row);
  }

  const reads = new Map<string, { streams: Set<number>; count: number }>();
  streams.forEach((stream, id) => {
    for (const call of stream.calls) {
      if (call.tool !== "Read") continue;
      const [step] = steps(call.tool, call.input, roots);
      const path = step!.slice("Read ".length);
      const row = reads.get(path) ?? { streams: new Set<number>(), count: 0 };
      row.streams.add(id);
      row.count += 1;
      reads.set(path, row);
    }
  });

  const durations = spans.map(([from, to]) => to - from);
  return {
    sources: {
      sessions: logs.length,
      streams: streams.length,
      calls: calls.length,
      from: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
      to: times.length > 0 ? new Date(Math.max(...times)).toISOString() : null,
    },
    stages: [...stageRuns]
      .map(([name, runs]) => ({ name, runs: runs.length, ms: runs.reduce((sum, ms) => sum + ms, 0), medianMs: median(runs) }))
      .sort((a, b) => b.ms - a.ms),
    waits: { count: spans.length, ms: durations.reduce((sum, ms) => sum + ms, 0), longestMs: durations.length > 0 ? Math.max(...durations) : 0 },
    slow: [...slow]
      .map(([step, all]) => ({ step, calls: all.length, ms: all.reduce((sum, ms) => sum + ms, 0), medianMs: median(all) }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, top),
    reviews: reviews(ledgers),
    sentBack: sentBack(logs),
    retries: retries(streams, roots).slice(0, top),
    misroutes: misroutes(logs, options.routes ?? linkedRoutes),
    dispatches: [...dispatches.values()].sort((a, b) => b.tokens - a.tokens),
    sequences: mineSequences(
      streams.map((stream) => ({ session: stream.session, steps: stream.calls.flatMap((call) => minable(call, roots)) })),
      minStreams,
      longest,
    ).slice(0, top),
    reads: [...reads]
      .filter(([, row]) => row.streams.size >= minStreams)
      .map(([path, row]) => ({ path, streams: row.streams.size, count: row.count }))
      .sort((a, b) => b.streams - a.streams || b.count - a.count || a.path.localeCompare(b.path))
      .slice(0, top),
  };
}

const times = (count: number) => (count === 1 ? "once" : `${count} times`);

/**
 * The report as a few lines per section for a person
 */
export function renderEfficiency(report: EfficiencyReport): string {
  const label = (name: string) => name.padEnd(11);
  const list = (name: string, rows: string[]) => (rows.length === 0 ? [`${label(name)}none`] : rows.map((row, index) => `${label(index === 0 ? name : "")}${row}`));
  const { sources } = report;
  return [
    `${label("Sources")}${sources.sessions} sessions, ${sources.streams} streams, ${sources.calls} tool calls${sources.from ? `, ${sources.from.slice(0, 10)} to ${sources.to!.slice(0, 10)}` : ""}`,
    ...list("Stages", report.stages.map((stage) => `${stage.name}: ${stage.runs} runs, ${duration(stage.ms)}, median ${duration(stage.medianMs)}`)),
    `${label("Waits")}${report.waits.count} on a person, ${duration(report.waits.ms)}, longest ${duration(report.waits.longestMs)}`,
    ...list("Slowest", report.slow.map((row) => `${row.step}: ${row.calls} calls, ${duration(row.ms)}, median ${duration(row.medianMs)}`)),
    ...list("Reviews", report.reviews.map((row) => `${row.work} task ${row.task}: ${row.rounds} rounds, ${row.opened} opened, ${row.fixed} fixed${row.capHit ? ", hit the cap" : ""}`)),
    ...list("Sent back", report.sentBack.map((row) => `${row.type}: ${times(row.returns)} over ${row.agents} agents`)),
    ...list("Retried", report.retries.map((row) => `${row.step}: ${row.failed} failed, ${row.retried} retried, ${row.recovered} recovered, ${row.unchanged} passed unchanged`)),
    ...list("Misroutes", report.misroutes.map((row) => `${row.session}: ${row.routes.join(", then ")}`)),
    ...list("Dispatches", report.dispatches.map((row) => `${row.type || "unknown"} on ${row.model ?? "unknown model"}: ${row.count} runs, ${row.turns} turns, ${row.tokens} tokens`)),
    ...list("Sequences", report.sequences.map((row) => `${times(row.count)} in ${row.streams} streams over ${row.sessions} sessions, saves ${row.saves} calls: ${row.steps.join(" > ")}`)),
    ...list("Reads", report.reads.map((row) => `${row.path}: ${row.streams} streams, ${row.count} reads`)),
  ].join("\n");
}
