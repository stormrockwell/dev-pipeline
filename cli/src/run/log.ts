import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const RUNS_DIR = ".pipeline/runs";

/**
 * Token counts of one or more model calls, split the way the API bills them
 */
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface Base {
  at: string;
  // The subagent that made the event, absent for the main session.
  agent?: string;
  agentType?: string;
}

export type RunEvent =
  | (Base & { kind: "session"; source: string; transcript: string | null })
  | (Base & { kind: "prompt"; text: string })
  | (Base & { kind: "tool"; tool: string; input: string; ok: boolean; ms: number | null; error?: string })
  | (Base & { kind: "stage"; name: string })
  | (Base & { kind: "dispatch"; agent: string; type: string; model: string | null; turns: number; tokens: Tokens; ms: number | null; work: string | null; task: string | null })
  | (Base & { kind: "stop"; model: string | null; turns: number; tokens: Tokens })
  | (Base & { kind: "end"; reason: string });

/**
 * One session's event log
 */
export interface RunLog {
  session: string;
  path: string;
  events: RunEvent[];
}

/**
 * The primary checkout that owns a directory, so a session in a worktree logs into the repo it came from
 */
export function primaryCheckout(cwd: string): string | null {
  if (!existsSync(cwd)) return null;
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" });
  if (result.status !== 0) return null;
  const common = result.stdout.trim();
  return basename(common) === ".git" ? dirname(common) : null;
}

/**
 * Where a session's log lives in the primary checkout
 */
export function logPath(repo: string, session: string): string {
  return join(repo, RUNS_DIR, `${session}.jsonl`);
}

/**
 * Appends events to a session's log
 *
 * Each event is one write of one line, so hooks that run at once interleave whole lines.
 */
export function appendEvents(path: string, events: RunEvent[]): void {
  if (events.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, events.map((event) => `${JSON.stringify(event)}\n`).join(""));
}

/**
 * Reads a log, skipping a torn last line from a write still in flight
 */
export function readLog(path: string): RunLog {
  const events: RunEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch {
      continue;
    }
  }
  return { session: basename(path, ".jsonl"), path, events };
}

/**
 * Every log in a repo, newest first by last write
 */
export function listLogs(repo: string): string[] {
  const dir = join(repo, RUNS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/**
 * The sum of token counts
 */
export function addTokens(...all: Tokens[]): Tokens {
  return all.reduce(
    (sum, tokens) => ({
      input: sum.input + tokens.input,
      output: sum.output + tokens.output,
      cacheRead: sum.cacheRead + tokens.cacheRead,
      cacheWrite: sum.cacheWrite + tokens.cacheWrite,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
}

/**
 * Every token a call read or wrote, cached or not
 */
export function totalTokens(tokens: Tokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

// A work folder in a path or command, with the task's worktree when it names one.
const WORK = /\.pipeline\/work\/([\w.-]+)\/(?:worktrees\/([\w.-]+)(?:\/|\b))?/;

/**
 * The work slug and task a piece of text points at, such as a brief path in a dispatch prompt
 */
export function workIn(text: string): { work: string | null; task: string | null } {
  const match = WORK.exec(text);
  return { work: match?.[1] ?? null, task: match?.[2] ?? null };
}
