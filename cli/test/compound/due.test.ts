import { existsSync, readFileSync, realpathSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, makeRepo, pipeline, removeTemps, tempDir, write } from "../helpers/repo.ts";

afterAll(removeTemps);

const DAY = 24 * 60 * 60 * 1000;
const MARKER = ".pipeline/compound/last-run.json";

/**
 * A checkout with a home folder that holds the given config, so nothing reads the real ~/.pipeline
 */
function setup(config: string | null): { repo: string; home: string } {
  const repo = realpathSync(makeRepo());
  const home = realpathSync(tempDir("pipeline-home-"));
  if (config !== null) write(home, ".pipeline/config.yml", config);
  return { repo, home };
}

/**
 * Records the days ago each half last ran
 */
function marker(repo: string, ago: { quality?: number; efficiency?: number }): void {
  const at = (days: number | undefined) => (days === undefined ? undefined : new Date(Date.now() - days * DAY).toISOString());
  write(repo, MARKER, JSON.stringify({ quality: at(ago.quality), efficiency: at(ago.efficiency) }));
}

/**
 * Writes a run log whose last write was some days ago
 */
function runLog(repo: string, name: string, daysAgo: number): void {
  write(repo, `.pipeline/runs/${name}.jsonl`, `${JSON.stringify({ kind: "prompt", at: new Date(Date.now() - daysAgo * DAY).toISOString(), text: "hi" })}\n`);
  const when = new Date(Date.now() - daysAgo * DAY);
  utimesSync(join(repo, `.pipeline/runs/${name}.jsonl`), when, when);
}

function due(repo: string, home: string, ...args: string[]) {
  return pipeline(repo, ["compound", "due", ...args], { env: { HOME: home } });
}

describe("pipeline compound due", () => {
  it("reminds a weekly developer after 7 days once run logs are newer than the last run", () => {
    const { repo, home } = setup(null);
    marker(repo, { efficiency: 9 });
    runLog(repo, "a", 3);
    runLog(repo, "b", 1);
    runLog(repo, "old", 12);

    const run = due(repo, home);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("Last /compound run was 9 days ago, 2 runs since. Run /compound? Setting weekly covers efficiency.\n");
  });

  it("prints hook JSON with the line and an instruction to offer once", () => {
    const { repo, home } = setup("compound: weekly\n");
    marker(repo, { efficiency: 9 });
    runLog(repo, "a", 3);

    const run = due(repo, home, "--hook");
    expect(run.status).toBe(0);
    const output = JSON.parse(run.stdout);
    expect(output.systemMessage).toBe("Last /compound run was 9 days ago, 1 run since. Run /compound?");
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput.additionalContext).toMatch(/once/);
    expect(output.hookSpecificOutput.additionalContext).toMatch(/only when they say yes/);
    expect(output.hookSpecificOutput.additionalContext).toMatch(/covers the efficiency half\./);
  });

  it("stays quiet for a weekly developer inside the week or with no new run logs", () => {
    const { repo, home } = setup(null);
    marker(repo, { efficiency: 3 });
    runLog(repo, "a", 1);
    expect(due(repo, home).stdout).toContain("Not due. Last /compound run was 3 days ago");
    expect(due(repo, home, "--hook").stdout).toBe("");

    marker(repo, { efficiency: 9 });
    runLog(repo, "a", 10);
    const quiet = due(repo, home);
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toContain("no new run logs");
    expect(due(repo, home, "--hook").stdout).toBe("");
  });

  it("is due on a first run once run logs exist, and not before", () => {
    const { repo, home } = setup(null);
    expect(due(repo, home).stdout).toContain("No /compound run yet, but no new run logs");
    runLog(repo, "a", 2);
    expect(due(repo, home).stdout).toBe("No /compound run yet, 1 run since. Run /compound? Setting weekly covers efficiency.\n");
  });

  it("reminds a lead after 7 days without a run log condition and covers both halves", () => {
    const { repo, home } = setup("compound: lead\n");
    expect(due(repo, home).stdout).toBe("No /compound run yet. Run /compound? Setting lead covers quality and efficiency.\n");

    marker(repo, { quality: 10, efficiency: 8 });
    expect(due(repo, home).stdout).toContain("Last /compound run was 8 days ago. Run /compound?");
    const output = JSON.parse(due(repo, home, "--hook").stdout);
    expect(output.hookSpecificOutput.additionalContext).toMatch(/covers the quality and efficiency halves\./);

    marker(repo, { quality: 10, efficiency: 2 });
    expect(due(repo, home).stdout).toContain("Not due");
  });

  it("never reminds a manual developer", () => {
    const { repo, home } = setup("compound: manual\n");
    runLog(repo, "a", 1);
    const run = due(repo, home);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Not due. The setting is manual");
    expect(due(repo, home, "--hook").stdout).toBe("");
  });

  it("treats a config with no compound key as weekly", () => {
    const { repo, home } = setup("other: thing\n");
    expect(due(repo, home).stdout).toContain("covers efficiency");
  });

  it("refuses an unknown setting, and falls back to weekly under --hook", () => {
    const { repo, home } = setup("compound: daily\n");
    marker(repo, { efficiency: 9 });
    runLog(repo, "a", 1);

    const run = due(repo, home);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("takes weekly, lead, manual");

    const hook = due(repo, home, "--hook");
    expect(hook.status).toBe(0);
    expect(JSON.parse(hook.stdout).systemMessage).toContain("9 days ago");
  });

  it("prints nothing and exits 0 under --hook when anything fails", () => {
    const { repo, home } = setup("compound: [unclosed\n: :\n");
    expect(due(repo, home, "--hook")).toMatchObject({ status: 0, stdout: "", stderr: "" });

    const outside = realpathSync(tempDir("pipeline-nogit-"));
    expect(due(outside, home, "--hook")).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(due(outside, home).status).toBe(2);
    expect(due(repo, home, "--bogus", "--hook").status).toBe(2);
  });

  it("ignores a marker it cannot read, as a first run", () => {
    const { repo, home } = setup("compound: lead\n");
    write(repo, MARKER, "not json");
    expect(due(repo, home).stdout).toContain("No /compound run yet");
  });

  it("is recorded by each half of the compounder and kept out of git", () => {
    const { repo, home } = setup(null);
    runLog(repo, "a", 1);
    const efficiency = pipeline(repo, ["compound", "efficiency"], { env: { HOME: home } });
    expect(efficiency.status).toBe(0);
    const first = JSON.parse(readFileSync(join(repo, MARKER), "utf8"));
    expect(first.efficiency).toMatch(/^\d{4}-/);
    expect(first.quality).toBeUndefined();
    expect(git(repo, "status", "--porcelain", "--untracked-files=all").stdout).not.toContain("last-run.json");
    expect(due(repo, home).stdout).toContain("Not due. Last /compound run was 0 days ago");
  });

  it("is not recorded when a half finds nothing to read", () => {
    const { repo, home } = setup(null);
    const run = pipeline(repo, ["compound", "efficiency"], { env: { HOME: home } });
    expect(run.status).toBe(2);
    expect(existsSync(join(repo, MARKER))).toBe(false);
  });
});
