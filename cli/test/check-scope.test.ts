import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bin, commit, makeRepo, planted, removeTemps, stage, tempDir, testEnv, write } from "./helpers/repo.ts";

afterAll(removeTemps);

function locate(name: string): string | undefined {
  const found = spawnSync("/usr/bin/env", ["which", name], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : undefined;
}

const gitleaks = locate("gitleaks");

// Each case starts real gitleaks, which can take seconds when the whole suite runs in parallel.
const slow = { timeout: 60_000 };

/** Runs the real floor with real gitleaks, because only the real scanner proves what gets scanned. */
function gitleaksResult(cwd: string) {
  const path = [dirname(gitleaks!), dirname(locate("git")!), "/usr/bin", "/bin"].join(":");
  const run = spawnSync(process.execPath, [bin, "check", "--json", "--timeout", "60"], {
    cwd,
    env: testEnv({ PATH: path }),
    encoding: "utf8",
    timeout: 90_000,
  });
  const parsed = JSON.parse(run.stdout) as { tools: { tool: string; status: string; summary: string }[] };
  return parsed.tools.find((entry) => entry.tool === "gitleaks")!;
}

const keyLine = (name: string) => `export const ${name} = "${planted.awsKey}";\n`;

describe.skipIf(!gitleaks || !existsSync(gitleaks))("gitleaks scan scope", slow, () => {
  it("does not scan git-ignored files", () => {
    const repo = makeRepo({ gitignore: "research/\n" });
    write(repo, "research/vendor/config.js", keyLine("ignored"));
    expect(gitleaksResult(repo).status).toBe("passed");
  });

  it("scans untracked files that are not ignored", () => {
    const repo = makeRepo({ gitignore: "research/\n" });
    write(repo, "src/new.js", keyLine("fresh"));
    expect(gitleaksResult(repo).status).toBe("failed");
  });

  it("scans tracked files", () => {
    const repo = makeRepo();
    stage(repo, "src/tracked.js", keyLine("tracked"));
    commit(repo);
    expect(gitleaksResult(repo).status).toBe("failed");
  });

  it("scans everything when the directory is not a git repo", () => {
    const dir = tempDir("pipeline-plain-");
    write(dir, "research/config.js", keyLine("plain"));
    expect(gitleaksResult(dir).status).toBe("failed");
  });

  it("skips a tracked file that was deleted from the working tree", () => {
    const repo = makeRepo();
    stage(repo, "src/gone.js", keyLine("gone"));
    commit(repo);
    rmSync(join(repo, "src/gone.js"));
    expect(gitleaksResult(repo).status).toBe("passed");
  });
});

describe.skipIf(!gitleaks || !existsSync(gitleaks))(".gitleaksignore", slow, () => {
  const fingerprint = (file: string, line: number) => `${file}:aws-access-token:${line}`;

  function twoLeaks(ignore: string): string {
    const repo = makeRepo();
    stage(repo, "fixtures/one.js", keyLine("one"));
    stage(repo, "fixtures/two.js", `export const pad = 1;\n${keyLine("two")}`);
    stage(repo, ".gitleaksignore", ignore);
    commit(repo);
    return repo;
  }

  it("suppresses only the finding whose fingerprint it lists", () => {
    const repo = twoLeaks(`${fingerprint("fixtures/one.js", 1)}\n`);
    expect(gitleaksResult(repo).status).toBe("failed");
  });

  it("passes once every finding is listed", () => {
    const repo = twoLeaks(`${fingerprint("fixtures/one.js", 1)}\n${fingerprint("fixtures/two.js", 2)}\n`);
    expect(gitleaksResult(repo).status).toBe("passed");
  });

  it("does not suppress the same file on a different line", () => {
    const repo = twoLeaks(`${fingerprint("fixtures/one.js", 1)}\n${fingerprint("fixtures/two.js", 1)}\n`);
    expect(gitleaksResult(repo).status).toBe("failed");
  });
});
