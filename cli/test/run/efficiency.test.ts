import { chmodSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Entry } from "../../src/ledger/ledger.ts";
import { efficiency, mineSequences, renderEfficiency } from "../../src/run/efficiency.ts";
import type { RunEvent, RunLog } from "../../src/run/log.ts";
import { commandStep, relativePath, statements, steps } from "../../src/run/shape.ts";
import { transcriptEvents, transcriptLog, transcriptRoutes } from "../../src/run/transcript.ts";
import { git, makeRepo, pipeline, removeTemps, tempDir, write } from "../helpers/repo.ts";

afterAll(removeTemps);

const roots = { repo: "/r/site", home: "/home/dev" };
const bash = (command: string) => steps("Bash", command, roots);

describe("steps", () => {
  it("splits a shell call into one step per statement, keeping the program and its subcommand", () => {
    expect(bash("cd /r/site && git -C ../site-wt/a status --porcelain && git worktree remove ../site-wt/a && git branch -D feat/a; git worktree list")).toEqual([
      "git status",
      "git worktree remove",
      "git branch",
      "git worktree list",
    ]);
    expect(bash("export PATH=/x:$PATH; cli/bin/pipeline review start --task 2")).toEqual(["pipeline review start"]);
    expect(bash("FOO=1 npx vitest run test/a.ts 2>&1 | tail -5")).toEqual(["npx vitest run"]);
    expect(bash("gh pr view 12 --json state -q .state")).toEqual(["gh pr view"]);
    expect(bash('echo "a && b" && git status')).toEqual(["echo", "git status"]);
    expect(bash("[ -f x ] && (cd cli && npm run check)")).toEqual(["npm run check"]);
  });

  it("drops a here-document's body and keeps the command it feeds", () => {
    expect(bash("python3 - <<'EOF'\nimport os\nos.remove('x')\nEOF\nnode --test plugin/test/*.mjs")).toEqual(["python3", "node --test"]);
    expect(statements("cat > a.txt <<EOF\nrm -rf /\nEOF")).toEqual(["cat > a.txt <<EOF"]);
    expect(commandStep("node plugin/evals/run.mjs --runs 1")).toBe("node run.mjs");
  });

  it("keeps a file tool's path the same across worktrees, works and machines", () => {
    expect(relativePath("/r/site/docs/PLAN.md", roots)).toBe("docs/PLAN.md");
    expect(relativePath("/r/site-wt/task-a/docs/PLAN.md", roots)).toBe("docs/PLAN.md");
    expect(relativePath("/r/site/.pipeline/work/ship/worktrees/2/src/a.ts", roots)).toBe("src/a.ts");
    expect(relativePath("/r/site/.pipeline/work/ship/work-order.md", roots)).toBe(".pipeline/work/*/work-order.md");
    expect(relativePath("/home/dev/.claude/CLAUDE.md", roots)).toBe("~/.claude/CLAUDE.md");
    expect(relativePath("/private/tmp/run-1/scratch/body.md", roots)).toBe("<tmp>/body.md");
    expect(steps("Read", "/r/site-wt/x/README.md", roots)).toEqual(["Read README.md"]);
    expect(steps("Agent", "dev-pipeline:implementer sonnet Build task 1", roots)).toEqual(["Agent dev-pipeline:implementer"]);
  });
});

describe("mineSequences", () => {
  const setup = ["git fetch", "git worktree add", "npm ci"];

  it("finds a sequence at its full length across streams, with the calls a script would save", () => {
    const found = mineSequences([
      { session: "s1", steps: ["Read a", ...setup, "Edit b"] },
      { session: "s1", steps: [...setup, "git status", ...setup] },
      { session: "s2", steps: ["git status", "git fetch", "git fetch", "git worktree add", "npm ci"] },
    ]);
    expect(found[0]).toEqual({ steps: setup, count: 4, streams: 3, sessions: 2, saves: 8 });
    expect(found.some((sequence) => sequence.steps.join() === "git fetch,git worktree add")).toBe(false);
  });

  it("leaves out a run seen in only one stream, and a step that only repeats itself", () => {
    expect(mineSequences([{ session: "s1", steps: [...setup, ...setup] }, { session: "s2", steps: ["npm ci", "npm ci"] }])).toEqual([]);
  });
});

// A transcript the way Claude Code writes it, one line per content block.
function transcriptFile(dir: string, name: string, lines: object[]): string {
  write(dir, name, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return join(dir, name);
}

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 10, 10, 0, seconds)).toISOString();
const usage = { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const say = (seconds: number, id: string, content: object[]) => ({ type: "assistant", timestamp: at(seconds), message: { id, model: "claude-opus-5-5", usage, content } });
const use = (seconds: number, id: string, name: string, input: object) => say(seconds, `m-${id}`, [{ type: "tool_use", id, name, input }]);
const result = (seconds: number, id: string, error = false) => ({ type: "user", timestamp: at(seconds), message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: error ? "Exit code 1\nmore" : "ok" }] } });
const human = (seconds: number, text: string) => ({ type: "user", timestamp: at(seconds), origin: { kind: "human" }, message: { content: text } });

describe("transcriptLog", () => {
  it("reads a session and its subagents into the events the hooks write", () => {
    const dir = tempDir();
    const main = transcriptFile(dir, "s1.jsonl", [
      human(0, "build it"),
      say(1, "m0", [{ type: "text", text: "Route: change, because it adds a feature." }]),
      use(2, "t1", "Skill", { skill: "dev-pipeline:build" }),
      result(3, "t1"),
      use(4, "t2", "Bash", { command: "npm test" }),
      result(9, "t2", true),
      { type: "user", timestamp: at(10), origin: { kind: "peer" }, message: { content: "[Subagent hand-back] done" } },
      { type: "assistant", isSidechain: true, timestamp: at(11), message: { id: "side", usage, content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "ls" } }] } },
      say(12, "m3", [{ type: "text", text: "Done." }]),
      human(40, "no, make it a quick change"),
      say(41, "m4", [{ type: "text", text: "Route: quick change, because the developer said so." }]),
    ]);
    transcriptFile(join(dir, "s1", "subagents"), "agent-a1.jsonl", [
      { type: "user", timestamp: at(5), message: { content: "Read your brief at /r/.pipeline/work/ship/worktrees/1/.pipeline/task/brief.md" } },
      use(6, "u1", "Read", { file_path: "/r/site/README.md" }),
      result(7, "u1"),
    ]);
    write(join(dir, "s1", "subagents"), "agent-a1.meta.json", JSON.stringify({ agentType: "dev-pipeline:implementer" }));

    const log = transcriptLog(main);
    const kinds = log.events.map((event) => event.kind);
    expect(kinds).toEqual(["session", "prompt", "tool", "stage", "tool", "stop", "prompt", "stop", "tool", "dispatch"]);
    expect(log.events).toContainEqual({ at: at(9), kind: "tool", tool: "Bash", input: "npm test", ok: false, ms: 5000, error: "Exit code 1" });
    expect(log.events).toContainEqual({ at: at(12), kind: "stop", model: "claude-opus-5-5", turns: 4, tokens: { input: 4, output: 40, cacheRead: 0, cacheWrite: 0 } });
    expect(log.events).toContainEqual({ at: at(7), agent: "a1", agentType: "dev-pipeline:implementer", kind: "tool", tool: "Read", input: "/r/site/README.md", ok: true, ms: 1000 });
    expect(log.events.at(-1)).toMatchObject({ kind: "dispatch", agent: "a1", type: "dev-pipeline:implementer", turns: 1, work: "ship", task: "1" });
    expect(transcriptRoutes(main).map((found) => found.route)).toEqual(["change", "quick change"]);
  });

  it("reads nothing from a missing transcript, or one a sandbox hides", () => {
    expect(transcriptEvents("/nope.jsonl")).toEqual([]);
    const hidden = transcriptFile(tempDir(), "hidden.jsonl", [say(1, "m0", [{ type: "text", text: "Route: change." }])]);
    chmodSync(hidden, 0o000);
    expect(transcriptRoutes(hidden)).toEqual([]);
    chmodSync(hidden, 0o600);
  });
});

describe("efficiency", () => {
  const tool = (seconds: number, input: string, ok = true, extra: Partial<RunEvent> = {}): RunEvent => ({ at: at(seconds), kind: "tool", tool: "Bash", input, ok, ms: 1000, ...extra }) as RunEvent;
  const edit = (seconds: number): RunEvent => ({ at: at(seconds), kind: "tool", tool: "Edit", input: "/r/site/src/a.ts", ok: true, ms: 10 });
  const read = (seconds: number, agent: string): RunEvent => ({ at: at(seconds), agent, agentType: "dev-pipeline:implementer", kind: "tool", tool: "Read", input: "/r/site/CLAUDE.md", ok: true, ms: 5 });
  const tokens = { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 };
  const dispatch = (seconds: number, agent: string): RunEvent => ({ at: at(seconds), kind: "dispatch", agent, type: "dev-pipeline:implementer", model: "claude-sonnet-5-5", turns: 3, tokens, ms: 1000, work: "ship", task: "1" });
  const cleanup = (from: number) => [tool(from, "gh pr view 3 --json state"), tool(from + 1, "git pull -q --ff-only"), tool(from + 2, "git worktree remove ../site-wt/a && git branch -D feat/a")];

  const s1: RunLog = {
    session: "s1",
    path: "s1.jsonl",
    events: [
      { at: at(0), kind: "prompt", text: "go" },
      { at: at(1), kind: "stage", name: "build" },
      ...cleanup(2),
      tool(10, "npm test", false),
      tool(11, "npm test"),
      tool(12, "npx vitest run", false),
      edit(13),
      tool(14, "npx vitest run"),
      read(15, "a1"),
      dispatch(16, "a1"),
      dispatch(18, "a1"),
      { at: at(20), kind: "stop", model: "claude-opus-5-5", turns: 2, tokens },
      { at: at(50), kind: "prompt", text: "next" },
    ],
  };
  const s2: RunLog = { session: "s2", path: "s2.jsonl", events: [...cleanup(0), read(5, "a2"), dispatch(6, "a2")] };
  const ledger: Entry[] = [1, 2, 3].map((round) => ({ kind: "round", at: at(round), task: "1", round, scope: round === 1 ? "full" : "fix", head: "abc", opened: 2, fixed: round - 1 }));

  const report = efficiency([s1, s2], [{ work: "ship", entries: ledger }], { roots, routes: (log) => (log.session === "s1" ? ["quick change", "quick change", "change"] : ["change"]) });

  it("mines the repeated sequence and the file every agent reads", () => {
    expect(report.sources).toMatchObject({ sessions: 2, streams: 4, calls: 13 });
    expect(report.sequences[0]).toEqual({ steps: ["gh pr view", "git pull", "git worktree remove", "git branch"], count: 2, streams: 2, sessions: 2, saves: 6 });
    expect(report.reads).toEqual([{ path: "CLAUDE.md", streams: 2, count: 2 }]);
  });

  it("tells a flaky pass from a retry that followed an edit", () => {
    expect(report.retries).toEqual([
      { step: "npm test", failed: 1, retried: 1, recovered: 1, unchanged: 1 },
      { step: "npx vitest run", failed: 1, retried: 1, recovered: 1, unchanged: 0 },
    ]);
  });

  it("counts review rounds, cap hits, agents sent back, waits, stages and misroutes", () => {
    expect(report.reviews).toEqual([{ work: "ship", task: "1", rounds: 3, opened: 6, fixed: 3, capHit: true }]);
    expect(report.sentBack).toEqual([{ type: "dev-pipeline:implementer", agents: 2, returns: 1 }]);
    expect(report.waits).toEqual({ count: 1, ms: 30_000, longestMs: 30_000 });
    expect(report.stages).toEqual([{ name: "build", runs: 1, ms: 19_000, medianMs: 19_000 }]);
    expect(report.misroutes).toEqual([{ session: "s1", routes: ["quick change", "change"] }]);
    expect(report.dispatches).toEqual([{ type: "dev-pipeline:implementer", model: "claude-sonnet-5-5", count: 2, turns: 6, tokens: 200 }]);
  });

  it("renders a line per finding", () => {
    const text = renderEfficiency(report);
    expect(text).toContain("Sequences  2 times in 2 streams over 2 sessions, saves 6 calls: gh pr view > git pull > git worktree remove > git branch");
    expect(text).toContain("Reviews    ship task 1: 3 rounds, 6 opened, 3 fixed, hit the cap");
    expect(text).toContain("Misroutes  s1: quick change, then change");
  });
});

describe("pipeline compound efficiency", () => {
  const line = (event: object) => `${JSON.stringify(event)}\n`;
  const cleanup = (seconds: number, agent?: string) =>
    ["gh pr view 3 --json state", "git pull -q --ff-only", "git worktree remove ../wt/a"].map((input, index) => line({ at: at(seconds + index), ...(agent ? { agent, agentType: "x" } : {}), kind: "tool", tool: "Bash", input, ok: true, ms: 10 })).join("");

  it("reports from the repo's run logs and ledgers, and writes the JSON for the analyst", () => {
    const repo = realpathSync(makeRepo());
    write(repo, ".pipeline/runs/s1.jsonl", cleanup(0) + cleanup(10, "a1"));
    write(repo, ".pipeline/work/ship/ledger.jsonl", line({ kind: "round", at: at(0), task: "1", round: 4, scope: "fix", head: "abc", opened: 1, fixed: 1 }));

    const run = pipeline(repo, ["compound", "efficiency", "--out", ".pipeline/compound/efficiency.json"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Sequences  2 times in 2 streams over 1 sessions, saves 4 calls: gh pr view > git pull > git worktree remove");
    expect(run.stdout).toContain("ship task 1: 4 rounds, 1 opened, 1 fixed, hit the cap");
    const saved = JSON.parse(readFileSync(join(repo, ".pipeline/compound/efficiency.json"), "utf8"));
    expect(saved.sources).toMatchObject({ sessions: 1, streams: 2, calls: 6 });
    expect(git(repo, "status", "--porcelain", "--untracked-files=all").stdout).not.toContain(".pipeline/compound");
  });

  it("reads Claude Code transcripts in place of run logs", () => {
    const dir = tempDir();
    for (const session of ["s1", "s2"]) transcriptFile(dir, `${session}.jsonl`, [human(0, "go"), use(1, "t1", "Bash", { command: "git fetch -q && git worktree add -q ../wt/a origin/main && npm ci" }), result(2, "t1")]);
    const run = pipeline(realpathSync(makeRepo()), ["compound", "efficiency", "--transcripts", dir, "--json"]);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).sequences[0]).toMatchObject({ steps: ["git fetch", "git worktree add", "npm ci"], streams: 2, sessions: 2 });
  });

  it("refuses bad usage and says when there is nothing to read", () => {
    const repo = realpathSync(makeRepo());
    expect(pipeline(repo, ["compound"]).status).toBe(2);
    expect(pipeline(repo, ["compound", "efficiency", "--since", "last week"]).status).toBe(2);
    expect(pipeline(repo, ["compound", "efficiency", "--top", "0"]).status).toBe(2);
    const empty = pipeline(repo, ["compound", "efficiency"]);
    expect(empty.status).toBe(2);
    expect(empty.stderr).toContain("no run logs");
  });
});
