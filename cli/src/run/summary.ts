import { addTokens, type RunEvent, type RunLog, type Tokens, totalTokens, workIn } from "./log.ts";

export interface Dispatch {
  agent: string;
  type: string;
  model: string | null;
  turns: number;
  tokens: Tokens;
  ms: number | null;
  work: string | null;
  task: string | null;
}

/**
 * What a set of run logs adds up to
 */
export interface RunSummary {
  sessions: string[];
  works: string[];
  stages: { name: string; ms: number }[];
  dispatches: Dispatch[];
  main: { model: string | null; turns: number; tokens: Tokens };
  tools: { calls: number; failures: number; byTool: Record<string, number> };
  waits: { count: number; ms: number };
}

const time = (event: RunEvent) => Date.parse(event.at);

/**
 * The spans a session spent waiting on a person
 *
 * A wait runs from the main session stopping to the next prompt, and an AskUserQuestion call is a
 * wait for as long as the tool ran.
 */
export function waits(events: RunEvent[]): [number, number][] {
  const spans: [number, number][] = [];
  let stopped: number | null = null;
  for (const event of events) {
    if (event.kind === "stop") stopped = time(event);
    if (event.kind === "prompt" && stopped !== null) {
      spans.push([stopped, time(event)]);
      stopped = null;
    }
    if (event.kind === "tool" && event.tool === "AskUserQuestion" && event.ms !== null) spans.push([time(event) - event.ms, time(event)]);
  }
  return spans;
}

function overlap([a, b]: [number, number], [c, d]: [number, number]): number {
  return Math.max(0, Math.min(b, d) - Math.max(a, c));
}

/**
 * Each stage's working time: from its skill firing to the next stage or the session's last event, less the waits inside it
 */
export function stages(events: RunEvent[], spans: [number, number][]): { name: string; ms: number }[] {
  const starts = events.filter((event) => event.kind === "stage" && event.agent === undefined);
  const end = events.length > 0 ? time(events.at(-1)!) : 0;
  return starts.map((start, index) => {
    const span: [number, number] = [time(start), index + 1 < starts.length ? time(starts[index + 1]!) : end];
    const waited = spans.reduce((sum, wait) => sum + overlap(span, wait), 0);
    return { name: (start as { name: string }).name, ms: Math.max(0, span[1] - span[0] - waited) };
  });
}

/**
 * The works a log touched, from the paths and commands it recorded
 */
function worksOf(events: RunEvent[]): string[] {
  const found = new Set<string>();
  for (const event of events) {
    const work = event.kind === "tool" ? workIn(event.input).work : event.kind === "dispatch" ? event.work : null;
    if (work !== null) found.add(work);
  }
  return [...found];
}

/**
 * Adds run logs up into stages, dispatches, the main session's spend, tool calls and waits
 *
 * A subagent's dispatch event repeats each time a Stop hook sends it back, with its running
 * totals, so the last one per agent counts. The main session's stop events carry running totals
 * too, so each session's last stop counts.
 */
export function summarize(logs: RunLog[]): RunSummary {
  const dispatches = new Map<string, Dispatch>();
  const byTool: Record<string, number> = {};
  const stageTotals = new Map<string, number>();
  const works = new Set<string>();
  let main = { model: null as string | null, turns: 0, tokens: addTokens() };
  let calls = 0;
  let failures = 0;
  let waitCount = 0;
  let waitMs = 0;

  for (const log of logs) {
    const events = [...log.events].sort((a, b) => time(a) - time(b));
    for (const event of events) {
      if (event.kind === "tool") {
        calls += 1;
        if (!event.ok) failures += 1;
        byTool[event.tool] = (byTool[event.tool] ?? 0) + 1;
      }
      if (event.kind === "dispatch") {
        const { agent, type, model, turns, tokens, ms, work, task } = event;
        dispatches.set(`${log.session}/${agent}`, { agent, type, model, turns, tokens, ms, work, task });
      }
    }
    const lastStop = events.filter((event) => event.kind === "stop").at(-1);
    if (lastStop?.kind === "stop") {
      main = { model: lastStop.model ?? main.model, turns: main.turns + lastStop.turns, tokens: addTokens(main.tokens, lastStop.tokens) };
    }
    const spans = waits(events);
    waitCount += spans.length;
    waitMs += spans.reduce((sum, [from, to]) => sum + (to - from), 0);
    for (const stage of stages(events, spans)) stageTotals.set(stage.name, (stageTotals.get(stage.name) ?? 0) + stage.ms);
    for (const work of worksOf(events)) works.add(work);
  }

  return {
    sessions: logs.map((log) => log.session),
    works: [...works],
    stages: [...stageTotals].map(([name, ms]) => ({ name, ms })),
    dispatches: [...dispatches.values()],
    main,
    tools: { calls, failures, byTool },
    waits: { count: waitCount, ms: waitMs },
  };
}

/**
 * Whether a log touched a work folder
 */
export function touches(log: RunLog, work: string): boolean {
  return worksOf(log.events).includes(work);
}

/**
 * A duration as minutes and seconds
 */
export function duration(ms: number | null): string {
  if (ms === null) return "unknown";
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * A token count in thousands or millions
 */
export function tokenCount(tokens: Tokens): string {
  const total = totalTokens(tokens);
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M tokens`;
  if (total >= 1000) return `${Math.round(total / 1000)}k tokens`;
  return `${total} tokens`;
}

/**
 * The summary as a few lines for a person
 */
export function renderSummary(summary: RunSummary): string {
  const label = (name: string) => name.padEnd(10);
  const tools = Object.entries(summary.tools.byTool)
    .sort((a, b) => b[1] - a[1])
    .map(([tool, count]) => `${tool} ${count}`)
    .join(", ");
  const lines = [
    `${label("Sessions")}${summary.sessions.length}${summary.works.length > 0 ? `, work ${summary.works.join(", ")}` : ""}`,
    `${label("Stages")}${summary.stages.map((stage) => `${stage.name} ${duration(stage.ms)}`).join(", ") || "none recorded"}`,
    ...summary.dispatches.map(
      (dispatch, index) =>
        `${label(index === 0 ? "Dispatch" : "")}${dispatch.type}${dispatch.task ? ` task ${dispatch.task}` : ""}, ${dispatch.model ?? "unknown model"}, ${dispatch.turns} turns, ${tokenCount(dispatch.tokens)}, ${duration(dispatch.ms)}`,
    ),
    `${label("Main")}${summary.main.model ?? "unknown model"}, ${summary.main.turns} turns, ${tokenCount(summary.main.tokens)}`,
    `${label("Tools")}${summary.tools.calls} calls, ${summary.tools.failures} failed${tools ? `: ${tools}` : ""}`,
    `${label("Waits")}${summary.waits.count} on a person, ${duration(summary.waits.ms)}`,
  ];
  return lines.join("\n");
}
