import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { describeInput, toEvents } from "../../src/run/hook.ts";
import type { RunEvent, RunLog } from "../../src/run/log.ts";
import { summarize } from "../../src/run/summary.ts";
import { transcriptUsage } from "../../src/run/transcript.ts";
import { git, makeRepo, pipeline, removeTemps, tempDir, write } from "../helpers/repo.ts";

afterAll(removeTemps);

const usage = (output: number, cacheRead = 0) => ({ input_tokens: 2, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 10 });

// A transcript the way Claude Code streams it, with each message's id repeated per content block.
function transcript(dir: string, prompt: string, model = "claude-sonnet-5-5"): string {
  const lines = [
    { type: "user", timestamp: "2026-11-10T10:00:00.000Z", message: { role: "user", content: prompt } },
    { type: "assistant", timestamp: "2026-11-10T10:00:05.000Z", message: { id: "msg_1", model, usage: usage(5) } },
    { type: "assistant", timestamp: "2026-11-10T10:00:06.000Z", message: { id: "msg_1", model, usage: usage(40) } },
    { type: "assistant", timestamp: "2026-11-10T10:00:08.000Z", message: { id: "msg_s", model: "<synthetic>", usage: usage(0) } },
    { type: "assistant", isSidechain: true, timestamp: "2026-11-10T10:00:09.000Z", message: { id: "msg_side", model: "claude-haiku-5-5", usage: usage(999) } },
    { type: "assistant", timestamp: "2026-11-10T10:00:30.000Z", message: { id: "msg_2", model, usage: usage(60, 1000) } },
  ];
  const path = join(dir, "transcript.jsonl");
  write(dir, "transcript.jsonl", `${lines.map((line) => JSON.stringify(line)).join("\n")}\n{"torn`);
  return path;
}

describe("transcriptUsage", () => {
  it("counts each message once with its last usage, and skips synthetic and sidechain lines", () => {
    const path = transcript(tempDir(), "Read your brief at /r/.pipeline/work/ship/worktrees/2/.pipeline/task/brief.md, then build task 2.");
    expect(transcriptUsage(path)).toEqual({
      model: "claude-sonnet-5-5",
      turns: 3,
      tokens: { input: 6, output: 100, cacheRead: 1000, cacheWrite: 30 },
      ms: 30_000,
      work: "ship",
      task: "2",
    });
  });

  it("counts sidechain lines in a subagent's own transcript", () => {
    expect(transcriptUsage(transcript(tempDir(), "hi"), true).turns).toBe(4);
  });

  it("returns nothing for a missing transcript", () => {
    expect(transcriptUsage("/nope.jsonl")).toMatchObject({ turns: 0, model: null, work: null });
  });
});

describe("toEvents", () => {
  const now = new Date("2026-11-10T10:00:00Z");

  it("keeps a tool call's command and outcome, never file contents", () => {
    expect(toEvents({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pipeline tdd red" }, duration_ms: 812 }, now)).toEqual([
      { at: "2026-11-10T10:00:00.000Z", kind: "tool", tool: "Bash", input: "pipeline tdd red", ok: true, ms: 812 },
    ]);
    expect(describeInput("Write", { file_path: "src/a.js", content: "secret" })).toBe("src/a.js");
  });

  it("keeps the first line of a failure and who made the call", () => {
    const [event] = toEvents(
      { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm test" }, error: "Exit code 1\nstack", agent_id: "a1", agent_type: "dev-pipeline:implementer" },
      now,
    );
    expect(event).toMatchObject({ kind: "tool", ok: false, error: "Exit code 1", agent: "a1", agentType: "dev-pipeline:implementer" });
  });

  it("starts a stage when one of the plugin's skills fires", () => {
    const fire = (skill: string) => toEvents({ hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill } }, now).map((event) => event.kind);
    expect(fire("dev-pipeline:build")).toEqual(["tool", "stage"]);
    expect(fire("security-review")).toEqual(["tool"]);
  });

  it("reads a dispatch's spend from its transcript when it stops", () => {
    const path = transcript(tempDir(), "Read your brief at /r/.pipeline/work/ship/worktrees/1/.pipeline/task/brief.md");
    const [event] = toEvents({ hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "dev-pipeline:implementer", agent_transcript_path: path }, now);
    expect(event).toMatchObject({ kind: "dispatch", agent: "a1", type: "dev-pipeline:implementer", model: "claude-sonnet-5-5", turns: 4, work: "ship", task: "1" });
  });

  it("ignores events it does not log", () => {
    expect(toEvents({ hook_event_name: "Notification" }, now)).toEqual([]);
  });
});

describe("pipeline run-log --hook", () => {
  const repoWithPipeline = () => {
    const repo = realpathSync(makeRepo());
    write(repo, ".pipeline/profile.yml", "stack: node\n");
    return repo;
  };
  const hook = (cwd: string, input: Record<string, unknown>) => pipeline(cwd, ["run-log", "--hook"], { input: JSON.stringify({ session_id: "s1", cwd, ...input }) });
  const log = (repo: string, session = "s1") => join(repo, ".pipeline/runs", `${session}.jsonl`);

  it("appends events to the session's log and keeps the folder out of git", () => {
    const repo = repoWithPipeline();
    expect(hook(repo, { hook_event_name: "SessionStart", source: "startup" })).toMatchObject({ status: 0, stdout: "" });
    hook(repo, { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "README.md" } });
    const kinds = readFileSync(log(repo), "utf8").trim().split("\n").map((line) => JSON.parse(line).kind);
    expect(kinds).toEqual(["session", "tool"]);
    expect(git(repo, "status", "--porcelain", "--untracked-files=all").stdout).not.toContain(".pipeline/runs");
  });

  it("logs a session in a worktree into the primary checkout", () => {
    const repo = repoWithPipeline();
    const worktree = join(realpathSync(tempDir()), "wt");
    git(repo, "worktree", "add", "-q", "-b", "wt/one", worktree);
    hook(worktree, { hook_event_name: "SessionStart" });
    expect(existsSync(log(repo))).toBe(true);
    expect(existsSync(log(worktree))).toBe(false);
  });

  it("writes nothing in a repo the pipeline has not set up", () => {
    const repo = realpathSync(makeRepo());
    hook(repo, { hook_event_name: "SessionStart" });
    expect(existsSync(join(repo, ".pipeline"))).toBe(false);
  });

  it("stays silent on bad input and refuses a session id that is not a plain name", () => {
    const repo = repoWithPipeline();
    expect(pipeline(repo, ["run-log", "--hook"], { input: "{not json" })).toMatchObject({ status: 0, stdout: "", stderr: "" });
    hook(repo, { hook_event_name: "SessionStart", session_id: "../escape" });
    expect(existsSync(join(repo, ".pipeline/escape.jsonl"))).toBe(false);
  });
});

describe("summarize", () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 10, 10, 10, 0, seconds)).toISOString();
  const tokens = (n: number) => ({ input: n, output: 0, cacheRead: 0, cacheWrite: 0 });
  const events: RunEvent[] = [
    { at: at(0), kind: "session", source: "startup", transcript: null },
    { at: at(1), kind: "prompt", text: "add free shipping" },
    { at: at(2), kind: "stage", name: "work-order" },
    { at: at(3), kind: "tool", tool: "Bash", input: "pipeline schedule .pipeline/work/ship/work-order.md", ok: true, ms: 100 },
    { at: at(10), kind: "stop", model: "claude-opus-5-5", turns: 3, tokens: tokens(100) },
    { at: at(40), kind: "prompt", text: "go" },
    { at: at(42), kind: "stage", name: "build" },
    { at: at(50), kind: "tool", tool: "Bash", input: "npm test", ok: false, ms: 900, error: "Exit code 1", agent: "a1", agentType: "dev-pipeline:implementer" },
    { at: at(60), kind: "dispatch", agent: "a1", type: "dev-pipeline:implementer", model: "claude-sonnet-5-5", turns: 4, tokens: tokens(50), ms: 15_000, work: "ship", task: "1" },
    { at: at(70), kind: "dispatch", agent: "a1", type: "dev-pipeline:implementer", model: "claude-sonnet-5-5", turns: 6, tokens: tokens(80), ms: 25_000, work: "ship", task: "1" },
    { at: at(80), kind: "stop", model: "claude-opus-5-5", turns: 7, tokens: tokens(300) },
  ];
  const run: RunLog = { session: "s1", path: "s1.jsonl", events };

  it("adds up stages less waits, the last dispatch per agent, the main session, tools and waits", () => {
    const summary = summarize([run]);
    expect(summary.stages).toEqual([
      { name: "work-order", ms: 10_000 },
      { name: "build", ms: 38_000 },
    ]);
    expect(summary.dispatches).toEqual([expect.objectContaining({ agent: "a1", turns: 6, tokens: tokens(80) })]);
    expect(summary.main).toEqual({ model: "claude-opus-5-5", turns: 7, tokens: tokens(300) });
    expect(summary.tools).toEqual({ calls: 2, failures: 1, byTool: { Bash: 2 } });
    expect(summary.waits).toEqual({ count: 1, ms: 30_000 });
    expect(summary.works).toEqual(["ship"]);
  });

  it("adds sessions together", () => {
    const summary = summarize([run, { ...run, session: "s2" }]);
    expect(summary.main.turns).toBe(14);
    expect(summary.dispatches).toHaveLength(2);
  });
});

describe("pipeline run-log", () => {
  it("summarizes the latest session, or every session of one work", () => {
    const repo = realpathSync(makeRepo());
    write(repo, ".pipeline/profile.yml", "stack: node\n");
    const send = (session: string, input: Record<string, unknown>) => pipeline(repo, ["run-log", "--hook"], { input: JSON.stringify({ session_id: session, cwd: repo, ...input }) });
    send("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pipeline brief .pipeline/work/ship/work-order.md 1" } });
    send("s2", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "README.md" } });

    const latest = pipeline(repo, ["run-log"]);
    expect(latest.status).toBe(0);
    expect(latest.stdout).toContain("Tools     1 calls, 0 failed: Read 1");
    const work = JSON.parse(pipeline(repo, ["run-log", "--work", "ship", "--json"]).stdout);
    expect(work).toMatchObject({ sessions: ["s1"], works: ["ship"] });
    expect(pipeline(repo, ["run-log", "--work", "other"]).status).toBe(2);
  });

  it("says when there is nothing to summarize", () => {
    const { status, stderr } = pipeline(realpathSync(makeRepo()), ["run-log"]);
    expect(status).toBe(2);
    expect(stderr).toContain("no logs");
  });
});
