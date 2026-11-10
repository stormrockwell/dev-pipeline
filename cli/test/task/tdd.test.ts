import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, pipeline, removeTemps } from "../helpers/repo.ts";
import { brief, commitAll, fixShipping, taskRepo, testWords, writeTest } from "./fixture.ts";

afterAll(removeTemps);

const runs = (repo: string) =>
  readFileSync(join(repo, ".pipeline/task/evidence.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

// Stands in for an agent that rewrites the recorded test command after the brief.
function setRecordedTest(repo: string, test: string): void {
  const path = join(repo, ".pipeline/task/task.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), test }));
}

describe("pipeline tdd", () => {
  it("runs the brief's test command and records a red run when it fails", () => {
    const repo = taskRepo();
    brief(repo);
    writeTest(repo);
    const { status, stdout } = pipeline(repo, ["tdd", "red"]);
    expect(status).toBe(0);
    expect(stdout).toContain("pipeline tdd: red recorded, the command failed with exit 1 as a red run should.");

    const [run] = runs(repo);
    expect(run).toMatchObject({ phase: "red", ok: true, exit: 1, command: testWords, head: git(repo, "rev-parse", "HEAD").stdout.trim() });
    expect(run.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(run.tree).not.toBe(git(repo, "rev-parse", "HEAD^{tree}").stdout.trim());
  });

  it("refuses a red run whose command passes", () => {
    const repo = taskRepo();
    brief(repo);
    fixShipping(repo);
    const { status, stdout } = pipeline(repo, ["tdd", "red"]);
    expect(status).toBe(1);
    expect(stdout).toContain("a red run needs a failing test");
    expect(runs(repo)[0]).toMatchObject({ phase: "red", ok: false, exit: 0 });
  });

  it("refuses a red run whose command never ran", () => {
    const repo = taskRepo();
    brief(repo, [], "no-such-test-runner");
    const { status, stdout } = pipeline(repo, ["tdd", "red"]);
    expect(status).toBe(1);
    expect(stdout).toContain("the command did not run");
    expect(runs(repo)[0]).toMatchObject({ ok: false, exit: null });
  });

  it("records a green run whose tree matches the commit that follows", () => {
    const repo = taskRepo();
    brief(repo);
    writeTest(repo);
    fixShipping(repo);
    const { status, stdout } = pipeline(repo, ["tdd", "green"]);
    expect(status).toBe(0);
    expect(stdout).toContain("pipeline tdd: green recorded");
    commitAll(repo);
    expect(runs(repo)[0].tree).toBe(git(repo, "rev-parse", "HEAD^{tree}").stdout.trim());
  });

  it("refuses a green run whose command fails", () => {
    const repo = taskRepo();
    brief(repo);
    const { status } = pipeline(repo, ["tdd", "green"]);
    expect(status).toBe(1);
    expect(runs(repo)[0]).toMatchObject({ phase: "green", ok: false, exit: 1 });
  });

  it("passes the test output through", () => {
    const repo = taskRepo();
    brief(repo, [], `node -e "console.log('expected 75 to ship free'); process.exit(1)"`);
    const { stdout } = pipeline(repo, ["tdd", "red"]);
    expect(stdout).toContain("expected 75 to ship free");
    expect(runs(repo)[0].tail).toContain("expected 75 to ship free");
  });

  it("appends arguments after -- as plain words, never through a shell", () => {
    const repo = taskRepo();
    brief(repo, [], `node -e "process.exit(process.argv.includes('--grep') ? 1 : 0)"`);
    const { status } = pipeline(repo, ["tdd", "red", "--", "--grep", ";", "touch", "pwned"]);
    expect(status).toBe(0);
    expect(runs(repo)[0].command.slice(-4)).toEqual(["--grep", ";", "touch", "pwned"]);
    expect(existsSync(join(repo, "pwned"))).toBe(false);
  });

  it("refuses a recorded command the guard would stop, and runs nothing", () => {
    const repo = taskRepo();
    brief(repo);
    setRecordedTest(repo, "git push --force origin main");
    const { status, stderr } = pipeline(repo, ["tdd", "red"]);
    expect(status).toBe(2);
    expect(stderr).toContain("pipeline guard");
    expect(existsSync(join(repo, ".pipeline/task/evidence.jsonl"))).toBe(false);

    setRecordedTest(repo, "npm test && git push");
    expect(pipeline(repo, ["tdd", "red"]).stderr).toContain("one plain command");
  });

  it("needs a phase, a briefed task and a recorded test command", () => {
    const repo = taskRepo();
    expect(pipeline(repo, ["tdd", "blue"]).status).toBe(2);
    const { status, stderr } = pipeline(repo, ["tdd", "red"]);
    expect(status).toBe(2);
    expect(stderr).toContain("no briefed task");

    pipeline(repo, ["brief", ".pipeline/work/ship/work-order.md", "2"]);
    const untested = pipeline(repo, ["tdd", "red"]);
    expect(untested.status).toBe(2);
    expect(untested.stderr).toContain("--test");
  });
});
