import { existsSync, readdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { executable, findOnPath, git, pipeline, removeTemps, tempDir } from "../helpers/repo.ts";
import { nodeSiteRepo } from "./fixtures.ts";

afterAll(removeTemps);

// Points core.hooksPath at /dev/null, as Claude Code's sandbox does.
const devNullHooks = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null" };

const answers = ["--answer", "type=node-site", "--answer", "name=demo-site", "--answer", "public=no", "--answer", "peer_review=no"];

describe("init --mode new where git keeps hooks out", () => {
  const dir = join(tempDir(), "demo-site");
  const result = pipeline(tempDir(), ["init", "--mode", "new", "--path", dir, ...answers], { env: devNullHooks });

  it("exits 0, because the scaffold is complete", () => {
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("created package.json");
  });

  it("starts the repo on main", () => {
    expect(result.stdout).toContain("initialised a git repo on main");
    expect(git(dir, "symbolic-ref", "HEAD").stdout.trim()).toBe("refs/heads/main");
  });

  it("prints one line saying the hooks were skipped, why, and how to install them later", () => {
    const lines = result.stdout.split("\n").filter((line) => line.includes("skipped the git hooks"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("the git hooks path is /dev/null, which is not a directory");
    expect(lines[0]).toContain(`Run pipeline hooks install in ${dir}`);
    expect(result.stderr).toBe("");
  });
});

/**
 * A PATH whose git fails init the way a sandbox guarding .git/config does, after making .git, and runs the real
 * git for everything else
 */
function refusingGit(message: string): Record<string, string> {
  const fake = tempDir("pipeline-git-");
  executable(
    join(fake, "git"),
    `#!/bin/sh\nif [ "$1" = init ]; then mkdir -p .git/objects; echo "${message}" >&2; exit 128; fi\nexec '${findOnPath("git")}' "$@"\n`,
  );
  return { PATH: [fake, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter) };
}

describe("init --mode new where git cannot write .git", () => {
  const dir = join(tempDir(), "demo-site");
  const env = refusingGit("error: could not lock config file .git/config: Operation not permitted");
  const result = pipeline(tempDir(), ["init", "--mode", "new", "--path", dir, ...answers], { env });

  it("exits 0 with the scaffold written", () => {
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("created package.json");
    expect(result.stderr).toBe("");
  });

  it("prints one line saying git init and the hooks were skipped, why, and what to run later", () => {
    const lines = result.stdout.split("\n").filter((line) => line.includes("skipped"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`skipped git init and the git hooks, because git cannot write ${join(dir, ".git")} here (Operation not permitted)`);
    expect(lines[0]).toContain(`Run git init -b main, then pipeline hooks install, in ${dir}`);
  });

  it("removes the .git folder the refused init left", () => {
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });
});

describe("init --mode new with a writable hooks directory", () => {
  const dir = join(tempDir(), "demo-site");
  const result = pipeline(tempDir(), ["init", "--mode", "new", "--path", dir, ...answers]);

  it("copies no sample hooks and installs the secret hooks", () => {
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(join(dir, ".git/hooks")).sort()).toEqual(["pre-commit", "pre-push"]);
    expect(pipeline(dir, ["hooks", "status"]).status).toBe(0);
  });
});

describe("init --mode new when a step really fails", () => {
  it("exits 1 when git init fails for a reason other than a refused write", () => {
    const dir = join(tempDir(), "demo-site");
    const env = refusingGit("fatal: unable to read the template directory");
    const result = pipeline(tempDir(), ["init", "--mode", "new", "--path", dir, ...answers], { env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pipeline init: git init failed. fatal: unable to read the template directory");
    expect(result.stdout).not.toContain("skipped");
  });

  it("exits 1 when an existing hook and its kept copy block the install", () => {
    const dir = tempDir();
    expect(git(dir, "init", "-q", "-b", "main").status).toBe(0);
    executable(join(dir, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 0\n");
    executable(join(dir, ".git/hooks/pre-commit.local"), "#!/bin/sh\nexit 0\n");
    const result = pipeline(dir, ["init", "--mode", "new", "--path", dir, ...answers]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pre-commit.local");
    expect(result.stdout).not.toContain("skipped the git hooks");
  });
});

describe("init --mode existing where git keeps hooks out", () => {
  it("exits 0 and points at pipeline hooks install", () => {
    const repo = nodeSiteRepo();
    const result = pipeline(repo, ["init", "--path", repo, "--mode", "existing", "--yes"], { env: devNullHooks });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("pipeline hooks install");
  });
});
