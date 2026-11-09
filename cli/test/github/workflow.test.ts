import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STATUS_CHECKS } from "../../src/commands/github/ruleset.ts";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const reusable = read(".github/workflows/pipeline-pr.yml");
const caller = read("templates/github/pipeline.yml");

describe("reusable workflow", () => {
  it("is callable and runs the four floor commands plus risk-gate", () => {
    expect(reusable).toMatch(/^on:\n {2}workflow_call:/m);
    for (const command of ["check --ci", "pr-check", "classify --range", "scan-zones --range", "risk-gate --range"]) {
      expect(reusable).toContain(`"$PIPELINE" ${command}`);
    }
    expect(reusable).toContain("classify --range \"$RANGE\" --json");
  });

  it("names its jobs so the ruleset's required checks match", () => {
    const jobs = [...reusable.matchAll(/^ {4}name: (\S+)$/gm)].map((match) => match[1]);
    expect(STATUS_CHECKS).toEqual(jobs.map((job) => `pipeline / ${job}`));
  });

  it("passes PR text through env vars, never into the script", () => {
    expect(reusable).not.toMatch(/run:[^\n]*\$\{\{ github\.event/);
    expect(reusable).toContain("PR_BODY: ${{ github.event.pull_request.body }}");
  });

  it("gives only the risk-gate job write access to pull requests", () => {
    expect(reusable.match(/pull-requests: write/g)).toHaveLength(1);
  });

  it("uses a merge base so a moved base branch does not show up in the diff", () => {
    expect(reusable).toContain("git merge-base");
  });
});

describe("caller template", () => {
  it("calls the reusable workflow from a job named pipeline", () => {
    expect(caller).toMatch(/^ {2}pipeline:\n {4}uses: stormrockwell\/dev-pipeline\/\.github\/workflows\/pipeline-pr\.yml@/m);
  });

  it("runs on pull requests and reviews", () => {
    expect(caller).toContain("pull_request:");
    expect(caller).toContain("pull_request_review:");
  });
});
