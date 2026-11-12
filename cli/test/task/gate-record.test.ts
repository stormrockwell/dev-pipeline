import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseHiddenComment, RECORD_VERSION, statsTable } from "../../src/commands/gate-record/record.ts";
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

  it("versions the record, names the plugin version and leaves out what nothing reported", () => {
    const repo = shipped();
    const found = record(repo);
    expect(found.version).toBe(RECORD_VERSION);
    expect(found.pipeline).toMatch(/^\d+\.\d+\.\d+/);
    expect(found.findings).toEqual({ opened: 0, fixed: 0, accepted: 0, overruled: 0, capHits: 0 });
    for (const absent of ["rounds", "retries", "redirects"]) expect(found).not.toHaveProperty(absent);
    expect(found.tasks[0]).not.toHaveProperty("stuck");
  });

  it("keeps each BLOCKED or NEEDS_CONTEXT report a task gave, with its cause", () => {
    const repo = shipped();
    const ledgerFile = join(repo, ".pipeline/work/ship/ledger.jsonl");
    const blocked = { kind: "task", at: "2026-11-10T09:00:00Z", task: "2", status: "BLOCKED", branch: null, base: "a", head: "a", evidence: "the readme is generated" };
    writeFileSync(ledgerFile, `${readFileSync(ledgerFile, "utf8")}${JSON.stringify(blocked)}\n`);
    expect(record(repo).tasks[1].stuck).toEqual([{ status: "BLOCKED", cause: "the readme is generated" }]);
  });

  it("counts the commands a session retried", () => {
    const repo = shipped();
    logSession(repo);
    const send = (input: Record<string, unknown>) => pipeline(repo, ["run-log", "--hook"], { input: JSON.stringify({ session_id: "s1", cwd: repo, ...input }) });
    for (const ok of [false, true]) {
      send({ hook_event_name: ok ? "PostToolUse" : "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm test" }, ...(ok ? {} : { error: "exit 1" }) });
    }
    expect(record(repo).retries).toEqual({ failed: 1, retried: 1, unchanged: 1 });
  });

  it("prints the stats table from the same record", () => {
    const repo = shipped();
    logSession(repo);
    const { stdout } = pipeline(repo, ["gate-record", order, "--stats"]);
    expect(stdout.trim()).toBe(statsTable(record(repo)));
    expect(stdout).toMatch(/^<details><summary>Pipeline stats<\/summary>\n\n\| Stat \| Value \|\n\|---\|---\|\n/);
    expect(stdout).toContain("| Tasks | 1 T2, 2 T0 |");
    expect(stdout).toContain("| Tokens | 2k: main unknown 0, implementer 1 claude-sonnet-5-5 2k |");
    expect(stdout.trim().endsWith("</details>")).toBe(true);
    expect(pipeline(repo, ["gate-record", order, "--stats", "--json"]).stderr).toContain("give one of");
  });

  it("reads a record back from a body edited in the browser, and gives null for a broken one", () => {
    expect(parseHiddenComment('text\r\n<!-- pipeline:gate-record\r\n{"version":1,"work":"w"}\r\n-->')).toEqual({ version: 1, work: "w" });
    expect(parseHiddenComment("<!-- pipeline:gate-record\n{not json\n-->")).toBeNull();
    expect(parseHiddenComment("no record")).toBeNull();
  });

  it("needs a scheduled work order", () => {
    const repo = taskRepo();
    write(repo, ".pipeline/work/new/work-order.md", "---\ntitle: New\ntasks: []\n---\n");
    expect(pipeline(repo, ["gate-record", ".pipeline/work/new/work-order.md"]).stderr).toContain("run `pipeline schedule");
  });
});
