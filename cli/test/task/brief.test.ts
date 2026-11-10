import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, pipeline, removeTemps, tempDir, write } from "../helpers/repo.ts";
import { brief, taskRepo } from "./fixture.ts";

afterAll(removeTemps);

const briefPath = (repo: string) => join(repo, ".pipeline/task/brief.md");
const record = (repo: string) => JSON.parse(readFileSync(join(repo, ".pipeline/task/task.json"), "utf8"));

describe("pipeline brief", () => {
  it("writes the task's brief and record into the worktree", () => {
    const repo = taskRepo();
    const { stdout, status, stderr } = brief(repo);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(`pipeline brief: wrote ${briefPath(repo)}`);

    const text = readFileSync(briefPath(repo), "utf8");
    expect(text).toMatch(/^# Task 1: Free shipping at the threshold\n/);
    expect(text).toContain("An order of exactly 75 ships free. Test it through freeShipping(total).");
    expect(text).not.toContain("Say the threshold is 75.");
    expect(text).toContain("Owned files  src/shipping.js, test/shipping.test.js");
    expect(text).toContain("Tier         T2");
    expect(text).toContain(`pipeline tdd red --task ${repo} -- npm test`);
    expect(text).toContain(`pipeline tdd green --task ${repo} -- npm test`);
    expect(text).toContain(`pipeline task-check --task ${repo}`);
    expect(text).toContain(`git -C ${repo} <command>`);
    expect(text).toContain("Comment only why, and keep comments evergreen.");
    expect(text).toContain(join(repo, ".pipeline/task/report.md"));
    expect(text).toContain(`Task: ${repo}`);

    const saved = record(repo);
    expect(saved).toMatchObject({ id: "1", tier: "T2", files: ["src/shipping.js", "test/shipping.test.js"], tdd: { required: true, reason: null }, test: "npm test" });
    expect(saved.base).toBe(git(repo, "rev-parse", "HEAD").stdout.trim());
  });

  it("keeps the task files out of git", () => {
    const repo = taskRepo();
    brief(repo);
    expect(git(repo, "status", "--porcelain").stdout).toBe("");
    expect(git(repo, "check-ignore", "-q", ".pipeline/task/task.json").status).toBe(0);
  });

  it("takes the tier and gates from the schedule, not the work order", () => {
    const repo = taskRepo();
    const order = readFileSync(join(repo, ".pipeline/work/ship/work-order.md"), "utf8");
    write(repo, ".pipeline/work/ship/work-order.md", order.replace("tier: T2", "tier: T1"));
    brief(repo);
    expect(record(repo).tier).toBe("T2");
  });

  it("drops TDD for a tier without the gate, and on request with a reason", () => {
    const repo = taskRepo();
    expect(pipeline(repo, ["brief", ".pipeline/work/ship/work-order.md", "2"]).status).toBe(0);
    expect(record(repo).tdd).toEqual({ required: false, reason: "T0 has no TDD gate" });
    expect(readFileSync(briefPath(repo), "utf8")).toContain("TDD          not required, because T0 has no TDD gate");

    const other = taskRepo();
    expect(brief(other, ["--no-tdd", "the developer declined a harness"]).status).toBe(0);
    expect(record(other).tdd).toEqual({ required: false, reason: "the developer declined a harness" });
  });

  it("writes into the worktree it is given", () => {
    const repo = taskRepo();
    const worktree = join(realpathSync(tempDir()), "wt");
    expect(git(repo, "worktree", "add", "-q", "-b", "wt/ship-1", worktree).status).toBe(0);
    const { status } = brief(repo, ["--worktree", worktree]);
    expect(status).toBe(0);
    expect(existsSync(briefPath(worktree))).toBe(true);
    expect(existsSync(briefPath(repo))).toBe(false);
    expect(git(worktree, "status", "--porcelain").stdout).toBe("");
  });

  it("refuses before the work order is scheduled", () => {
    const repo = taskRepo();
    write(repo, ".pipeline/work/other/work-order.md", readFileSync(join(repo, ".pipeline/work/ship/work-order.md"), "utf8"));
    const { status, stderr } = pipeline(repo, ["brief", ".pipeline/work/other/work-order.md", "1"]);
    expect(status).toBe(2);
    expect(stderr).toContain("run `pipeline schedule");
  });

  it("refuses an unknown task and a task with no section", () => {
    const repo = taskRepo();
    expect(pipeline(repo, ["brief", ".pipeline/work/ship/work-order.md", "9"]).stderr).toContain("no task 9");
    const order = readFileSync(join(repo, ".pipeline/work/ship/work-order.md"), "utf8");
    write(repo, ".pipeline/work/ship/work-order.md", order.replace("## Task 1: Free shipping at the threshold", "## Notes"));
    const { status, stderr } = brief(repo);
    expect(status).toBe(2);
    expect(stderr).toContain('no "## Task 1" section');
  });

  it("refuses a worktree that already holds another task", () => {
    const repo = taskRepo();
    expect(brief(repo).status).toBe(0);
    expect(brief(repo).status).toBe(0);
    const { status, stderr } = pipeline(repo, ["brief", ".pipeline/work/ship/work-order.md", "2"]);
    expect(status).toBe(2);
    expect(stderr).toContain("already holds task 1");
  });
});
