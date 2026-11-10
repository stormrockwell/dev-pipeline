import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseHiddenComment } from "../../src/commands/gate-record/record.ts";
import { pipeline, removeTemps, write } from "../helpers/repo.ts";
import { brief, commitAll, fixShipping, taskRepo, writeTest } from "./fixture.ts";

afterAll(removeTemps);

const order = ".pipeline/work/ship/work-order.md";

function shipped(): string {
  const repo = taskRepo();
  brief(repo);
  writeTest(repo);
  pipeline(repo, ["tdd", "red"]);
  fixShipping(repo);
  commitAll(repo);
  pipeline(repo, ["tdd", "green"]);
  write(repo, ".pipeline/task/report.md", "Status: DONE\n\nAn order of exactly 75 ships free.\n");
  expect(pipeline(repo, ["task-check"]).status).toBe(0);
  return repo;
}

// Logs a session that ran the work: the orchestrator's spend at stop and one implementer dispatch.
function logSession(repo: string): void {
  const send = (input: Record<string, unknown>) => pipeline(repo, ["run-log", "--hook"], { input: JSON.stringify({ session_id: "s1", cwd: repo, ...input }) });
  send({ hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "dev-pipeline:build" } });
  send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `pipeline brief ${order} 1` } });
  const transcript = join(repo, ".pipeline/work/agent.jsonl");
  write(
    repo,
    ".pipeline/work/agent.jsonl",
    [
      { type: "user", timestamp: "2026-11-10T10:00:00Z", message: { content: `Read your brief at ${repo}/.pipeline/work/ship/worktrees/1/.pipeline/task/brief.md` } },
      { type: "assistant", timestamp: "2026-11-10T10:01:00Z", message: { id: "m1", model: "claude-sonnet-5-5", usage: { input_tokens: 1000, output_tokens: 500 } } },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
  send({ hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "dev-pipeline:implementer", agent_transcript_path: transcript });
}

const record = (repo: string, args: string[] = []) => JSON.parse(pipeline(repo, ["gate-record", order, "--json", ...args]).stdout);

describe("pipeline gate-record", () => {
  it("passes TDD from the task's check and leaves unrecorded gates pending", () => {
    const repo = shipped();
    const { tasks, gates } = record(repo);
    expect(tasks[0]).toMatchObject({ id: "1", tier: "T2", status: "DONE", branch: "main" });
    expect(tasks[1]).toMatchObject({ id: "2", status: null, commits: null });
    expect(gates.filter((gate: { task: string }) => gate.task === "1")).toEqual([
      { task: "1", gate: "TDD", result: "pass", note: "red then green" },
      { task: "1", gate: "simplifier", result: "pending", note: null },
      { task: "1", gate: "standards", result: "pending", note: null },
      { task: "1", gate: "spec", result: "pending", note: null },
      { task: "1", gate: "quick security review", result: "pending", note: null },
    ]);
  });

  it("takes gate results and rulings from the ledger, and keeps gates the plan did not name", () => {
    const repo = shipped();
    pipeline(repo, ["ledger", "gate", order, "--task", "1", "--gate", "spec", "--result", "pass"]);
    pipeline(repo, ["ledger", "gate", order, "--task", "1", "--gate", "performance", "--result", "skip", "--note", "no queries"]);
    pipeline(repo, ["ledger", "rule", order, "--task", "1", "--decided", "Kept 75", "--why", "the order says so", "--cost", "a rename"]);
    const { gates, rulings } = record(repo);
    expect(gates).toContainEqual({ task: "1", gate: "spec", result: "pass", note: null });
    expect(gates).toContainEqual({ task: "1", gate: "performance", result: "skip", note: "no queries" });
    expect(rulings).toEqual([{ task: "1", decided: "Kept 75", why: "the order says so", cost: "a rename" }]);
  });

  it("counts the spend of the sessions and dispatches that ran the work", () => {
    const repo = shipped();
    logSession(repo);
    const { cost, stages, sessions } = record(repo);
    expect(cost.dispatches).toEqual([{ type: "dev-pipeline:implementer", model: "claude-sonnet-5-5", task: "1", turns: 1, tokens: 1500 }]);
    expect(cost.tokens).toBe(1500);
    expect(stages.map((stage: { name: string }) => stage.name)).toEqual(["build"]);
    expect(sessions).toBe(1);
  });

  it("limits the record to one PR's tasks", () => {
    const repo = shipped();
    const plan = JSON.parse(readFileSync(join(repo, ".pipeline/work/ship/plan.json"), "utf8"));
    const pr = plan.prs.find((entry: { tasks: string[] }) => entry.tasks.includes("2"));
    const { tasks, pr: name } = record(repo, ["--pr", pr.name]);
    expect(name).toBe(pr.name);
    expect(tasks.map((task: { id: string }) => task.id)).toEqual(pr.tasks);
    expect(pipeline(repo, ["gate-record", order, "--pr", "ZZ"]).stderr).toContain("no PR ZZ");
  });

  it("writes the record beside the work order and prints it as a hidden comment that survives double hyphens", () => {
    const repo = shipped();
    pipeline(repo, ["ledger", "rule", order, "--decided", "Use --force-with-lease --> never", "--why", "safety", "--cost", "none"]);
    const { stdout } = pipeline(repo, ["gate-record", order, "--comment"]);
    expect(stdout.trim().split("\n").slice(1, -1).join("\n")).not.toContain("--");
    const parsed = parseHiddenComment(stdout);
    expect(parsed?.rulings[0]?.decided).toBe("Use --force-with-lease --> never");
    expect(JSON.parse(readFileSync(join(repo, ".pipeline/work/ship/gate-record.json"), "utf8"))).toEqual(parsed);
  });

  it("needs a scheduled work order", () => {
    const repo = taskRepo();
    write(repo, ".pipeline/work/new/work-order.md", "---\ntitle: New\ntasks: []\n---\n");
    expect(pipeline(repo, ["gate-record", ".pipeline/work/new/work-order.md"]).stderr).toContain("run `pipeline schedule");
  });
});
