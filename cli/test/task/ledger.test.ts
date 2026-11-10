import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, pipeline, removeTemps, write } from "../helpers/repo.ts";
import { brief, commitAll, fixShipping, taskRepo, writeTest } from "./fixture.ts";

afterAll(removeTemps);

const order = ".pipeline/work/ship/work-order.md";
const ledgerFile = (repo: string) => join(repo, ".pipeline/work/ship/ledger.jsonl");
const entries = (repo: string) =>
  existsSync(ledgerFile(repo))
    ? readFileSync(ledgerFile(repo), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];

function shipped(): string {
  const repo = taskRepo();
  brief(repo);
  writeTest(repo);
  expect(pipeline(repo, ["tdd", "red"]).status).toBe(0);
  fixShipping(repo);
  commitAll(repo);
  expect(pipeline(repo, ["tdd", "green"]).status).toBe(0);
  write(repo, ".pipeline/task/report.md", "Status: DONE\n\nAn order of exactly 75 ships free.\n");
  return repo;
}

describe("task-check writes the ledger", () => {
  it("records a passing task once, however many checks pass", () => {
    const repo = shipped();
    expect(pipeline(repo, ["task-check"]).status).toBe(0);
    expect(pipeline(repo, ["task-check"]).status).toBe(0);
    const head = git(repo, "rev-parse", "HEAD").stdout.trim();
    expect(entries(repo)).toEqual([
      expect.objectContaining({ kind: "task", task: "1", status: "DONE", branch: "main", head, evidence: "red then green" }),
    ]);
  });

  it("records nothing from a draft check or a failing one", () => {
    const repo = shipped();
    expect(pipeline(repo, ["task-check", "--draft"]).status).toBe(0);
    write(repo, ".pipeline/task/report.md", "Done.\n");
    expect(pipeline(repo, ["task-check"]).status).toBe(1);
    expect(entries(repo)).toEqual([]);
  });

  it("records a hand back from the Stop hook", () => {
    const repo = taskRepo();
    brief(repo);
    const input = JSON.stringify({ hook_event_name: "SubagentStop", cwd: repo, last_assistant_message: `Status: NEEDS_CONTEXT\n\nWhich threshold?\nTask: ${repo}` });
    expect(pipeline(repo, ["task-check", "--hook"], { input }).stdout).toBe("");
    expect(entries(repo)).toEqual([expect.objectContaining({ task: "1", status: "NEEDS_CONTEXT", evidence: "handed back" })]);
  });
});

describe("pipeline ledger", () => {
  it("prints each task's result and the next task", () => {
    const repo = shipped();
    pipeline(repo, ["task-check"]);
    const { status, stdout } = pipeline(repo, ["ledger", order]);
    expect(status).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines[0]).toBe("Ledger  Let an order at the threshold ship free");
    expect(lines[1]).toMatch(/^Task 1 {2}DONE, main, [0-9a-f]{7}\.\.[0-9a-f]{7}, red then green$/);
    expect(lines[2]).toBe("Task 2  not started");
    expect(lines.at(-1)).toBe("Next    task 2");
  });

  it("holds back a task whose need is not done", () => {
    const repo = taskRepo();
    expect(pipeline(repo, ["ledger", order]).stdout.trim().split("\n").at(-1)).toBe("Next    task 1");
    write(repo, ".pipeline/work/ship/ledger.jsonl", `${JSON.stringify({ kind: "task", at: "2026-01-01T00:00:00Z", task: "1", status: "BLOCKED", branch: null, base: "a", head: "a", evidence: "handed back" })}\n`);
    expect(pipeline(repo, ["ledger", order]).stdout.trim().split("\n").at(-1)).toBe("Next    task 1");
  });

  it("records a ruling with why and what it costs", () => {
    const repo = taskRepo();
    const { status } = pipeline(repo, ["ledger", "rule", order, "--task", "1", "--decided", "Kept the threshold at 75.", "--why", "the work order names it", "--cost", "one more task"]);
    expect(status).toBe(0);
    expect(entries(repo)).toEqual([expect.objectContaining({ kind: "ruling", task: "1", decided: "Kept the threshold at 75", why: "the work order names it", cost: "one more task" })]);
    expect(pipeline(repo, ["ledger", order]).stdout).toContain("Ruling  task 1: Kept the threshold at 75. Why: the work order names it. Cost if wrong: one more task.");
  });

  it("refuses a ruling without a reason or a cost", () => {
    const repo = taskRepo();
    const { status, stderr } = pipeline(repo, ["ledger", "rule", order, "--decided", "Kept it"]);
    expect(status).toBe(2);
    expect(stderr).toContain("needs --decided, --why and --cost");
  });

  it("records gate results, and a skip only with its reason", () => {
    const repo = taskRepo();
    expect(pipeline(repo, ["ledger", "gate", order, "--task", "1", "--gate", "spec", "--result", "pass"]).status).toBe(0);
    expect(pipeline(repo, ["ledger", "gate", order, "--task", "1", "--gate", "axe", "--result", "skip"]).stderr).toContain("needs --note");
    expect(pipeline(repo, ["ledger", "gate", order, "--task", "1", "--gate", "axe", "--result", "maybe"]).stderr).toContain("pass, fail or skip");
    expect(pipeline(repo, ["ledger", "gate", order, "--task", "9", "--gate", "spec", "--result", "pass"]).stderr).toContain("no task 9");
    expect(pipeline(repo, ["ledger", order]).stdout).toContain("Gate    task 1 spec pass");
  });
});
