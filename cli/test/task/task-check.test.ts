import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pipeline, removeTemps, tempDir, write } from "../helpers/repo.ts";
import { brief, commitAll, fixShipping, taskRepo, testCommand, writeTest } from "./fixture.ts";

afterAll(removeTemps);

const report = (status = "DONE", extra = "") =>
  `Status: ${status}\n\n## What I built\nAn order of exactly 75 ships free.\n\n## Tests\n1 of 1 passing.\n${extra}`;

// Runs the whole task the way the brief asks: red, fix, commit, green, report.
function shipped(): string {
  const repo = taskRepo();
  brief(repo);
  writeTest(repo);
  expect(pipeline(repo, ["tdd", "red", "--", ...testCommand]).status).toBe(0);
  fixShipping(repo);
  commitAll(repo);
  expect(pipeline(repo, ["tdd", "green", "--", ...testCommand]).status).toBe(0);
  write(repo, ".pipeline/task/report.md", report());
  return repo;
}

const check = (repo: string, args: string[] = []) => pipeline(repo, ["task-check", ...args]);

describe("pipeline task-check", () => {
  it("passes a task that shipped with red then green evidence", () => {
    const repo = shipped();
    const { status, stdout } = check(repo);
    expect(stdout).toBe("task-check: passed, task 1 is DONE with red then green evidence\n");
    expect(status).toBe(0);
  });

  it("checks a worktree named by --task from anywhere", () => {
    const repo = shipped();
    expect(check(tempDir(), ["--task", repo]).status).toBe(0);
  });

  it("needs the report and its status line", () => {
    const repo = shipped();
    write(repo, ".pipeline/task/report.md", "I fixed it.\n");
    expect(check(repo).stdout).toContain("the report has no Status line");

    const missing = taskRepo();
    brief(missing);
    const { status, stdout } = check(missing);
    expect(status).toBe(1);
    expect(stdout).toContain(`write the report at ${join(missing, ".pipeline/task/report.md")}`);
  });

  it("lets a blocked task stop without commits or evidence", () => {
    const repo = taskRepo();
    brief(repo);
    write(repo, ".pipeline/task/report.md", "Status: NEEDS_CONTEXT\n\nWhich threshold applies to wholesale orders?\n");
    const { status, stdout } = check(repo);
    expect(status).toBe(0);
    expect(stdout).toContain("task 1 is NEEDS_CONTEXT");
  });

  it("fails uncommitted work and a branch with no commit", () => {
    const repo = taskRepo();
    brief(repo);
    write(repo, ".pipeline/task/report.md", report());
    fixShipping(repo);
    const { status, stdout } = check(repo);
    expect(status).toBe(1);
    expect(stdout).toContain("commit or revert the uncommitted changes: src/shipping.js");
    expect(stdout).toContain("no commit since the brief");
  });

  it("fails a TDD task without a red run before green", () => {
    const repo = taskRepo();
    brief(repo);
    writeTest(repo);
    fixShipping(repo);
    commitAll(repo);
    pipeline(repo, ["tdd", "green", "--", ...testCommand]);
    write(repo, ".pipeline/task/report.md", report());
    expect(check(repo).stdout).toContain("no red run before the green one");
  });

  it("fails when the last green run tested other code than HEAD", () => {
    const repo = shipped();
    write(repo, "src/shipping.js", "export const freeShipping = (total) => total >= 70;\n");
    commitAll(repo, "fix(shipping): lower the threshold");
    expect(check(repo).stdout).toContain("the last green run tested other code than HEAD");
  });

  it("fails a file the task does not own unless the report names it", () => {
    const repo = shipped();
    write(repo, "src/cart.js", "export const cart = [];\n");
    commitAll(repo, "feat(cart): add a cart");
    pipeline(repo, ["tdd", "green", "--", ...testCommand]);
    expect(check(repo).stdout).toContain("src/cart.js is not an owned file");

    write(repo, ".pipeline/task/report.md", report("DONE_WITH_CONCERNS", "\n## Unplanned\nsrc/cart.js, because checkout reads it.\n"));
    expect(check(repo).status).toBe(0);
  });

  it("needs no evidence when the task has no TDD gate", () => {
    const repo = taskRepo();
    pipeline(repo, ["brief", ".pipeline/work/ship/work-order.md", "2"]);
    write(repo, "README.md", "# Project\n\nOrders of 75 or more ship free.\n");
    commitAll(repo, "docs: state the threshold");
    write(repo, ".pipeline/task/report.md", report());
    const { status, stdout } = check(repo);
    expect(stdout).toBe("task-check: passed, task 2 is DONE, TDD not required because T0 has no TDD gate\n");
    expect(status).toBe(0);
  });

  it("fails a temporal comment in the task's diff", () => {
    const repo = shipped();
    write(repo, "src/shipping.js", "// Changed the threshold, previously it was 50.\nexport const freeShipping = (total) => total >= 75;\n");
    commitAll(repo, "docs(shipping): explain the threshold");
    pipeline(repo, ["tdd", "green", "--", ...testCommand]);
    const { status, stdout } = check(repo);
    expect(status).toBe(1);
    expect(stdout).toContain("src/shipping.js:1  temporal");
  });

  it("exits 2 outside a briefed task", () => {
    const { status, stderr } = check(taskRepo());
    expect(status).toBe(2);
    expect(stderr).toContain("no briefed task");
  });
});

describe("pipeline task-check --hook", () => {
  const hook = (cwd: string, input: Record<string, unknown>) =>
    pipeline(cwd, ["task-check", "--hook"], { input: JSON.stringify({ hook_event_name: "SubagentStop", cwd, stop_hook_active: false, ...input }) });

  it("lets a passing task stop silently", () => {
    const repo = shipped();
    const { status, stdout } = hook(repo, {});
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("blocks a failing task with the problems as the next instruction", () => {
    const repo = taskRepo();
    brief(repo);
    const { status, stdout } = hook(repo, {});
    expect(status).toBe(0);
    const decision = JSON.parse(stdout);
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("write the report at");
    expect(decision.reason).toContain("pipeline task-check");
  });

  it("finds the task from the Task line when the hook runs elsewhere", () => {
    const repo = taskRepo();
    brief(repo);
    const elsewhere = tempDir();
    const { stdout } = hook(elsewhere, { last_assistant_message: `Status: DONE\nTask: ${repo}` });
    expect(JSON.parse(stdout).reason).toContain("write the report at");
  });

  it("asks for the Task line once when it cannot find the task", () => {
    const elsewhere = tempDir();
    expect(JSON.parse(hook(elsewhere, {}).stdout).reason).toContain("Task: <worktree>");
    expect(hook(elsewhere, { stop_hook_active: true }).stdout).toBe("");
  });

  it("stops blocking after three tries so a stuck agent can hand back", () => {
    const repo = taskRepo();
    brief(repo);
    for (let attempt = 0; attempt < 3; attempt++) expect(JSON.parse(hook(repo, {}).stdout).decision).toBe("block");
    const { status, stdout } = hook(repo, { stop_hook_active: true });
    expect(status).toBe(0);
    expect(JSON.parse(stdout).systemMessage).toContain("still fails");
  });
});
