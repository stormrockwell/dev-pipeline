import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, pipeline, removeTemps } from "../helpers/repo.ts";
import { brief, commitAll, fixShipping, taskRepo, testCommand, writeTest } from "./fixture.ts";

afterAll(removeTemps);

const runs = (repo: string) =>
  readFileSync(join(repo, ".pipeline/task/evidence.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

describe("pipeline tdd", () => {
  it("records a red run when the test command fails", () => {
    const repo = taskRepo();
    brief(repo);
    writeTest(repo);
    const { status, stdout } = pipeline(repo, ["tdd", "red", "--", ...testCommand]);
    expect(status).toBe(0);
    expect(stdout).toContain("pipeline tdd: red recorded, the command failed with exit 1 as a red run should.");

    const [run] = runs(repo);
    expect(run).toMatchObject({ phase: "red", ok: true, exit: 1, command: testCommand, head: git(repo, "rev-parse", "HEAD").stdout.trim() });
    expect(run.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(run.tree).not.toBe(git(repo, "rev-parse", "HEAD^{tree}").stdout.trim());
  });

  it("refuses a red run whose command passes", () => {
    const repo = taskRepo();
    brief(repo);
    fixShipping(repo);
    const { status, stdout } = pipeline(repo, ["tdd", "red", "--", ...testCommand]);
    expect(status).toBe(1);
    expect(stdout).toContain("a red run needs a failing test");
    expect(runs(repo)[0]).toMatchObject({ phase: "red", ok: false, exit: 0 });
  });

  it("refuses a red run whose command never ran", () => {
    const repo = taskRepo();
    brief(repo);
    const { status, stdout } = pipeline(repo, ["tdd", "red", "--", "no-such-test-runner"]);
    expect(status).toBe(1);
    expect(stdout).toContain("the command did not run");
    expect(runs(repo)[0]).toMatchObject({ ok: false, exit: null });
  });

  it("records a green run whose tree matches the commit that follows", () => {
    const repo = taskRepo();
    brief(repo);
    writeTest(repo);
    fixShipping(repo);
    const { status, stdout } = pipeline(repo, ["tdd", "green", "--", ...testCommand]);
    expect(status).toBe(0);
    expect(stdout).toContain("pipeline tdd: green recorded");
    commitAll(repo);
    expect(runs(repo)[0].tree).toBe(git(repo, "rev-parse", "HEAD^{tree}").stdout.trim());
  });

  it("refuses a green run whose command fails", () => {
    const repo = taskRepo();
    brief(repo);
    const { status } = pipeline(repo, ["tdd", "green", "--", ...testCommand]);
    expect(status).toBe(1);
    expect(runs(repo)[0]).toMatchObject({ phase: "green", ok: false, exit: 1 });
  });

  it("passes the test output through", () => {
    const repo = taskRepo();
    brief(repo);
    const { stdout } = pipeline(repo, ["tdd", "red", "--", "node", "-e", "console.log('expected 75 to ship free'); process.exit(1)"]);
    expect(stdout).toContain("expected 75 to ship free");
    expect(runs(repo)[0].tail).toContain("expected 75 to ship free");
  });

  it("needs a phase, a command and a briefed task", () => {
    const repo = taskRepo();
    expect(pipeline(repo, ["tdd", "blue", "--", "true"]).status).toBe(2);
    brief(repo);
    expect(pipeline(repo, ["tdd", "red"]).status).toBe(2);
    const bare = taskRepo();
    const { status, stderr } = pipeline(bare, ["tdd", "red", "--", ...testCommand]);
    expect(status).toBe(2);
    expect(stderr).toContain("no briefed task");
  });
});
