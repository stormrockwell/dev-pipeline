import { afterAll, describe, expect, it } from "vitest";
import type { RecordJson } from "../../src/commands/pr-body/auditors.ts";
import { securityStatus, statusCall } from "../../src/commands/security-status/status.ts";
import { pipeline, removeTemps } from "../helpers/repo.ts";
import { brief, commitAll, fixShipping, taskRepo, writeTest } from "./fixture.ts";

afterAll(removeTemps);

const head = "a".repeat(40);
const record = (gates: RecordJson["gates"], commits = `${"1".repeat(40)}..${head}`): RecordJson => ({
  work: "ship",
  pr: null,
  tasks: [{ id: "1", tier: "T2", zones: [], status: "DONE", commits }],
  gates,
});
const gate = (result: RecordJson["gates"][number]["result"], extra: { note?: string | null; head?: string } = {}) => ({ task: "1", gate: "quick security review", result, note: extra.note ?? null, ...(extra.head ? { head: extra.head } : {}) });

describe("securityStatus", () => {
  it("is success when every security gate passed at the task's head", () => {
    expect(securityStatus(record([gate("pass", { head })]))).toEqual({ state: "success", description: "Security gate passed for 1 task" });
  });

  it("is failure naming the task and gate that nobody recorded", () => {
    expect(securityStatus(record([gate("pending")]))).toEqual({ state: "failure", description: "Security gate missing: quick security review for task 1 (not recorded)" });
  });

  it("is failure with the skip note for a skipped gate", () => {
    expect(securityStatus(record([gate("skip", { note: "reviewer not built" })])).description).toBe("Security gate missing: quick security review for task 1 (reviewer not built)");
  });

  it("is failure when the pass judged an older commit than the task's", () => {
    const status = securityStatus(record([gate("pass", { head: "b".repeat(40) })]));
    expect(status.state).toBe("failure");
    expect(status.description).toBe("Security gate stale: quick security review for task 1 passed at bbbbbbb, task is at aaaaaaa");
  });

  it("is failure for a failed gate", () => {
    expect(securityStatus(record([gate("fail")]))).toEqual({ state: "failure", description: "Security gate failed: quick security review for task 1" });
  });

  it("keeps the description within the 140 characters GitHub takes", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ ...gate("pending"), task: String(index + 1) }));
    const tasks = many.map((entry) => ({ id: entry.task, tier: "T2", zones: [], status: "DONE" }));
    expect(securityStatus({ ...record([]), tasks, gates: many }).description.length).toBeLessThanOrEqual(140);
  });
});

describe("statusCall", () => {
  it("prints the gh api call for the sha, with the pipeline/security context", () => {
    expect(statusCall("acme/shop", head, { state: "failure", description: "Security gate missing: quick security review for task 1 (not recorded)" })).toBe(
      `gh api repos/acme/shop/statuses/${head} -f state=failure -f context=pipeline/security -f description='Security gate missing: quick security review for task 1 (not recorded)'`,
    );
  });

  it("strips characters a shell would treat as syntax from the description", () => {
    expect(statusCall("acme/shop", head, { state: "failure", description: "it's $(bad); `x` | y" })).toContain("-f description='its (bad) x  y'");
  });
});

describe("pipeline security-status", () => {
  const order = ".pipeline/work/ship/work-order.md";
  function shipped(): string {
    const repo = taskRepo();
    brief(repo);
    writeTest(repo);
    pipeline(repo, ["tdd", "red"]);
    fixShipping(repo);
    commitAll(repo);
    pipeline(repo, ["tdd", "green"]);
    return repo;
  }
  const status = (repo: string) => pipeline(repo, ["security-status", order, "--repo", "acme/shop", "--sha", head]);

  it("prints a failure call while the security gate is unrecorded", () => {
    const { stdout, status: code } = status(shipped());
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(new RegExp(`^gh api repos/acme/shop/statuses/${head} -f state=failure -f context=pipeline/security -f description='Security gate missing: quick security review for task 1 \\(not recorded\\)`));
  });

  it("prints a success call once the gate passed", () => {
    const repo = shipped();
    for (const [task, name] of [["1", "quick security review"], ["2", "light security pass"]]) pipeline(repo, ["ledger", "gate", order, "--task", task, "--gate", name!, "--result", "pass"]);
    const { stdout } = status(repo);
    expect(stdout.trim()).toBe(`gh api repos/acme/shop/statuses/${head} -f state=success -f context=pipeline/security -f description='Security gate passed for 2 tasks'`);
  });

  it("needs a sha it can read and a repo it can name", () => {
    const repo = shipped();
    const { stderr, status: code } = pipeline(repo, ["security-status", order, "--sha", "nothex"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--sha");
  });
});
