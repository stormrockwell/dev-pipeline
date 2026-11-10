import { existsSync, readFileSync } from "node:fs";
import { addTokens, type Tokens, workIn } from "./log.ts";

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

interface Entry {
  type?: string;
  isSidechain?: boolean;
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
  return content.map((block: { type?: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
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
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (!subagent && entry.isSidechain === true) continue;
    const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isNaN(at)) {
      first ??= at;
      last = at;
    }
    if (entry.type === "user" && prompt === null) prompt = text(entry.message?.content);
    const message = entry.message;
    if (entry.type !== "assistant" || !message?.id || !message.usage) continue;
    if (message.model && message.model !== "<synthetic>") model = message.model;
    messages.set(message.id, {
      input: message.usage.input_tokens ?? 0,
      output: message.usage.output_tokens ?? 0,
      cacheRead: message.usage.cache_read_input_tokens ?? 0,
      cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    });
  }
  return {
    model,
    turns: messages.size,
    tokens: addTokens(...messages.values()),
    ms: first !== null && last !== null ? last - first : null,
    ...workIn(prompt ?? ""),
  };
}
