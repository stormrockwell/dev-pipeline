import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { addTokens, clip, describeInput, PLUGIN_SKILL, type RunEvent, type RunLog, type Tokens, workIn } from "./log.ts";

/**
 * What a Claude Code transcript says a session or subagent spent
 */
export interface Usage {
  model: string | null;
  turns: number;
  tokens: Tokens;
  ms: number | null;
  work: string | null;
  task: string | null;
}

interface Block {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface Entry {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string };
  timestamp?: string;
  message?: {
    id?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

const NONE: Usage = { model: null, turns: 0, tokens: addTokens(), ms: null, work: null, task: null };

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block: Block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

/**
 * A transcript's lines as entries, skipping a torn last line from a write still in flight
 *
 * A transcript this process may not read, as inside a sandbox that hides Claude Code's own
 * folders, reads as empty.
 */
function* entries(path: string): Generator<Entry> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      yield JSON.parse(line) as Entry;
    } catch {
      continue;
    }
  }
}

/**
 * The model and token counts of an assistant line, or null for a line that made no model call
 */
function call(entry: Entry): { id: string; model: string | null; tokens: Tokens } | null {
  const message = entry.message;
  if (entry.type !== "assistant" || !message?.id || !message.usage) return null;
  return {
    id: message.id,
    model: message.model && message.model !== "<synthetic>" ? message.model : null,
    tokens: {
      input: message.usage.input_tokens ?? 0,
      output: message.usage.output_tokens ?? 0,
      cacheRead: message.usage.cache_read_input_tokens ?? 0,
      cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

/**
 * Sums a transcript's model calls
 *
 * Claude Code writes one line per streamed content block, each repeating its message's id and
 * usage, so a message counts once, with the usage from its last line. The first prompt names the
 * work folder when the dispatch carried a brief path. A main transcript can hold subagent lines
 * marked as a sidechain, and those count toward the subagent instead.
 */
export function transcriptUsage(path: string | undefined, subagent = false): Usage {
  if (!path || !existsSync(path)) return NONE;
  const messages = new Map<string, Tokens>();
  let model: string | null = null;
  let first: number | null = null;
  let last: number | null = null;
  let prompt: string | null = null;
  for (const entry of entries(path)) {
    if (!subagent && entry.isSidechain === true) continue;
    const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isNaN(at)) {
      first ??= at;
      last = at;
    }
    if (entry.type === "user" && prompt === null) prompt = text(entry.message?.content);
    const made = call(entry);
    if (made === null) continue;
    model = made.model ?? model;
    messages.set(made.id, made.tokens);
  }
  return {
    model,
    turns: messages.size,
    tokens: addTokens(...messages.values()),
    ms: first !== null && last !== null ? last - first : null,
    ...workIn(prompt ?? ""),
  };
}

/**
 * Whether a user line is a person typing, not a tool result, a hand-back or an injected reminder
 *
 * Newer transcripts mark the sender in `origin`. Older ones do not, and there a prompt that opens
 * with a tag is injected text, unless the tag is a slash command the person typed.
 */
function typed(entry: Entry): boolean {
  if (entry.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true) return false;
  const content = entry.message?.content;
  if (Array.isArray(content) && content.some((block: Block) => block.type === "tool_result")) return false;
  if (entry.origin !== undefined) return entry.origin.kind === "human";
  const said = text(content).trimStart();
  return !said.startsWith("<") || said.startsWith("<command-");
}

/**
 * Who made a subagent transcript's events
 */
export interface Maker {
  agent: string;
  agentType: string;
}

/**
 * Reads a transcript into the events the run log's hooks would have written
 *
 * A tool event lands when its result does, with the time between the call and the result. A main
 * transcript also yields each typed prompt and a stop at the last model line before it, with the
 * running spend, and leaves its sidechain lines to the subagent's own transcript. A subagent's
 * events carry its maker, as the hooks tag them.
 */
export function transcriptEvents(path: string, maker: Maker | null = null): RunEvent[] {
  if (!existsSync(path)) return [];
  const events: RunEvent[] = [];
  const by = maker ?? {};
  const pending = new Map<string, { tool: string; input: string; at: number }>();
  const messages = new Map<string, Tokens>();
  let model: string | null = null;
  let answered: string | null = null;
  const stop = () => {
    if (maker === null && answered !== null) events.push({ at: answered, kind: "stop", model, turns: messages.size, tokens: addTokens(...messages.values()) });
    answered = null;
  };
  for (const entry of entries(path)) {
    if (maker === null && entry.isSidechain === true) continue;
    const at = entry.timestamp;
    if (!at) continue;
    const content = Array.isArray(entry.message?.content) ? (entry.message.content as Block[]) : [];
    const made = call(entry);
    if (made !== null) {
      model = made.model ?? model;
      messages.set(made.id, made.tokens);
      answered = at;
      for (const block of content) {
        if (block.type === "tool_use" && block.id && block.name) pending.set(block.id, { tool: block.name, input: describeInput(block.name, block.input), at: Date.parse(at) });
      }
    }
    if (entry.type !== "user") continue;
    for (const block of content) {
      const id = block.type === "tool_result" ? block.tool_use_id : undefined;
      const started = id === undefined ? undefined : pending.get(id);
      if (id === undefined || started === undefined) continue;
      pending.delete(id);
      const ok = block.is_error !== true;
      const event: RunEvent = { at, ...by, kind: "tool", tool: started.tool, input: started.input, ok, ms: Math.max(0, Date.parse(at) - started.at) };
      if (!ok) event.error = clip(text(block.content).split("\n")[0] ?? "", 200);
      events.push(event);
      const stage = started.tool === "Skill" && ok ? PLUGIN_SKILL.exec(started.input) : null;
      if (stage) events.push({ at, ...by, kind: "stage", name: stage[1]! });
    }
    if (maker === null && typed(entry)) {
      stop();
      events.push({ at, kind: "prompt", text: clip(text(entry.message?.content), 200) });
    }
  }
  stop();
  return events;
}

/**
 * The subagent transcripts Claude Code keeps beside a session's transcript
 */
export function subagentTranscripts(path: string): string[] {
  const dir = join(dirname(path), basename(path, ".jsonl"), "subagents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^agent-[\w-]+\.jsonl$/.test(name))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * The agent type Claude Code recorded for a subagent transcript, from the meta file beside it
 */
function agentType(path: string): string {
  try {
    const meta = JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf8")) as { agentType?: unknown };
    return typeof meta.agentType === "string" ? meta.agentType : "";
  } catch {
    return "";
  }
}

/**
 * A session's transcript and its subagents' transcripts as one run log
 *
 * A repo without run logs, or a session from before the plugin's hooks, gets the same analysis
 * this way. Each subagent adds its tool events and one dispatch with its spend.
 */
export function transcriptLog(path: string): RunLog {
  const main = transcriptEvents(path);
  const events: RunEvent[] = main.length > 0 ? [{ at: main[0]!.at, kind: "session", source: "transcript", transcript: path }, ...main] : [];
  for (const sub of subagentTranscripts(path)) {
    const maker = { agent: basename(sub, ".jsonl").replace(/^agent-/, ""), agentType: agentType(sub) };
    const own = transcriptEvents(sub, maker);
    const usage = transcriptUsage(sub, true);
    if (own.length === 0 && usage.turns === 0) continue;
    const at = own.at(-1)?.at ?? events[0]?.at ?? new Date(0).toISOString();
    events.push(...own, { at, kind: "dispatch", agent: maker.agent, type: maker.agentType, model: usage.model, turns: usage.turns, tokens: usage.tokens, ms: usage.ms, work: usage.work, task: usage.task });
  }
  return { session: basename(path, ".jsonl"), path, events };
}

// The line the router opens a reply with, as in "Route: quick change, because it is a typo.".
const ROUTE = /^Route: ([a-z][a-z ]*?)(?:,|\.|$)/gm;

/**
 * The routes a session's main thread named, in order
 */
export function transcriptRoutes(path: string | null): { at: string; route: string }[] {
  if (path === null || !existsSync(path)) return [];
  const routes: { at: string; route: string }[] = [];
  for (const entry of entries(path)) {
    if (entry.type !== "assistant" || entry.isSidechain === true || !entry.timestamp) continue;
    for (const match of text(entry.message?.content).matchAll(ROUTE)) routes.push({ at: entry.timestamp, route: match[1]! });
  }
  return routes;
}
