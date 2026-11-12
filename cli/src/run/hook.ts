import { existsSync } from "node:fs";
import { join } from "node:path";
import { excludeLocally } from "../task/git.ts";
import { appendEvents, clip, describeInput, logPath, PLUGIN_SKILL, primaryCheckout, RUNS_DIR, type RunEvent } from "./log.ts";
import { transcriptUsage } from "./transcript.ts";

/**
 * The fields of a Claude Code hook payload the run log reads
 */
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  source?: string;
  reason?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  error?: string;
  duration_ms?: number;
}

/**
 * The run log events one hook payload makes
 */
export function toEvents(input: HookInput, now: Date = new Date()): RunEvent[] {
  const at = now.toISOString();
  const by = input.agent_id ? { agent: input.agent_id, agentType: input.agent_type ?? "" } : {};
  switch (input.hook_event_name) {
    case "SessionStart":
      return [{ at, kind: "session", source: input.source ?? "", transcript: input.transcript_path ?? null }];
    case "UserPromptSubmit":
      return [{ at, kind: "prompt", text: clip(input.prompt ?? "", 200) }];
    case "PostToolUse":
    case "PostToolUseFailure": {
      const tool = input.tool_name ?? "";
      const ok = input.hook_event_name === "PostToolUse";
      const event: RunEvent = { at, ...by, kind: "tool", tool, input: describeInput(tool, input.tool_input), ok, ms: input.duration_ms ?? null };
      if (!ok && input.error) event.error = clip(input.error.split("\n")[0] ?? "", 200);
      const stage = tool === "Skill" && ok ? PLUGIN_SKILL.exec(describeInput(tool, input.tool_input)) : null;
      return stage ? [event, { at, ...by, kind: "stage", name: stage[1]! }] : [event];
    }
    case "SubagentStop": {
      const usage = transcriptUsage(input.agent_transcript_path, true);
      return [
        {
          at,
          kind: "dispatch",
          agent: input.agent_id ?? "",
          type: input.agent_type ?? "",
          model: usage.model,
          turns: usage.turns,
          tokens: usage.tokens,
          ms: usage.ms,
          work: usage.work,
          task: usage.task,
        },
      ];
    }
    case "Stop": {
      const usage = transcriptUsage(input.transcript_path);
      return [{ at, kind: "stop", model: usage.model, turns: usage.turns, tokens: usage.tokens }];
    }
    case "SessionEnd":
      return [{ at, kind: "end", reason: input.reason ?? "" }];
    default:
      return [];
  }
}

/**
 * Records a hook payload in its session's log, in repos the pipeline set up
 *
 * A repo without a .pipeline folder gets nothing written, so the plugin's hooks stay silent in
 * every other project. The first write of a session ignores the runs folder locally when the repo
 * does not ignore it already.
 */
export function recordHook(input: HookInput, now: Date = new Date()): string | null {
  if (!input.cwd || !input.session_id || !/^[\w-]+$/.test(input.session_id)) return null;
  const repo = primaryCheckout(input.cwd);
  if (repo === null || !existsSync(join(repo, ".pipeline"))) return null;
  const path = logPath(repo, input.session_id);
  if (!existsSync(path)) excludeLocally(repo, `${RUNS_DIR}/`, `${RUNS_DIR}/${input.session_id}.jsonl`);
  appendEvents(path, toEvents(input, now));
  return path;
}
