import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  commit,
  executable,
  git,
  makeBareRemote,
  makeRepo,
  pipeline,
  planted,
  removeTemps,
  stage,
  tempDir,
  write,
} from "./helpers/repo.ts";

afterAll(removeTemps);

function hooksDir(repo: string): string {
  return join(repo, ".git", "hooks");
}

// Points core.hooksPath at /dev/null, as Claude Code's sandbox does.
const devNullHooks = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null" };

function installed(): string {
  const repo = makeRepo();
  const result = pipeline(repo, ["hooks", "install"]);
  expect(result.status).toBe(0);
  return repo;
}

describe("hooks install", () => {
  it("writes executable pre-commit and pre-push hooks", () => {
    const repo = installed();
    for (const name of ["pre-commit", "pre-push"]) {
      const path = join(hooksDir(repo), name);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o111).not.toBe(0);
    }
    expect(readFileSync(join(hooksDir(repo), "pre-commit"), "utf8")).toContain("secrets --staged");
    expect(readFileSync(join(hooksDir(repo), "pre-push"), "utf8")).toContain("secrets --range");
  });

  it("is idempotent and does not chain its own hook", () => {
    const repo = installed();
    expect(pipeline(repo, ["hooks", "install"]).status).toBe(0);
    expect(existsSync(join(hooksDir(repo), "pre-commit.local"))).toBe(false);
    expect(existsSync(join(hooksDir(repo), "pre-push.local"))).toBe(false);
  });

  it("fails outside a git repository", () => {
    const { status, stderr } = pipeline(tempDir(), ["hooks", "install"]);
    expect(status).toBe(1);
    expect(stderr).toContain("git");
  });

  it("documents the prepare script in its usage text", () => {
    const { stdout, status } = pipeline(tempDir(), ["hooks", "--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("prepare");
    expect(stdout).toContain("pipeline hooks install");
  });

  it("writes nothing and says why when git sets the hooks path to /dev/null", () => {
    const repo = makeRepo();
    const result = pipeline(repo, ["hooks", "install"], { env: devNullHooks });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("hooks not installed, because the git hooks path is /dev/null, which is not a directory");
    expect(result.stderr).toContain('Run "pipeline hooks install" again');
    expect(existsSync(join(hooksDir(repo), "pre-commit"))).toBe(false);
  });

  it("writes nothing and says why when the hooks directory is read only", () => {
    const repo = makeRepo();
    mkdirSync(hooksDir(repo), { recursive: true });
    chmodSync(hooksDir(repo), 0o555);
    try {
      const result = pipeline(repo, ["hooks", "install"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/hooks not installed, because git cannot write to .*hooks here \(EACCES\)/);
    } finally {
      chmodSync(hooksDir(repo), 0o755);
    }
  });

  it("creates the hooks directory in a repo made from an empty template", () => {
    const repo = tempDir();
    expect(git(repo, "init", "-q", "--template=", "-b", "main").status).toBe(0);
    expect(pipeline(repo, ["hooks", "install"]).status).toBe(0);
    expect(readFileSync(join(hooksDir(repo), "pre-commit"), "utf8")).toContain("secrets --staged");
  });

  it("exits 2 for an unknown subcommand", () => {
    expect(pipeline(tempDir(), ["hooks", "bogus"]).status).toBe(2);
  });
});

describe("chaining", () => {
  it("keeps an existing hook, runs it after the scan and tells the user", () => {
    const repo = makeRepo();
    const marker = join(repo, "chained-ran");
    const original = `#!/bin/sh\necho "$@" > "${marker}"\n`;
    executable(join(hooksDir(repo), "pre-commit"), original);
    const result = pipeline(repo, ["hooks", "install"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pre-commit.local");
    expect(readFileSync(join(hooksDir(repo), "pre-commit.local"), "utf8")).toBe(original);

    stage(repo, "a.ts", "export const a = 1;\n");
    expect(git(repo, "commit", "-q", "-m", "feat: a").status).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it("fails the commit when the chained hook fails", () => {
    const repo = makeRepo();
    executable(join(hooksDir(repo), "pre-commit"), "#!/bin/sh\nexit 1\n");
    pipeline(repo, ["hooks", "install"]);
    stage(repo, "a.ts", "export const a = 1;\n");
    expect(git(repo, "commit", "-q", "-m", "feat: a").status).not.toBe(0);
  });

  it("does not run the chained hook when the scan already failed", () => {
    const repo = makeRepo();
    const marker = join(repo, "chained-ran");
    executable(join(hooksDir(repo), "pre-commit"), `#!/bin/sh\ntouch "${marker}"\n`);
    pipeline(repo, ["hooks", "install"]);
    stage(repo, "a.ts", `const k = "${planted.awsKey}";\n`);
    expect(git(repo, "commit", "-q", "-m", "feat: a").status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses to overwrite when a previous chained hook already exists", () => {
    const repo = makeRepo();
    executable(join(hooksDir(repo), "pre-commit"), "#!/bin/sh\nexit 0\n");
    executable(join(hooksDir(repo), "pre-commit.local"), "#!/bin/sh\necho older\n");
    const result = pipeline(repo, ["hooks", "install"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pre-commit.local");
    expect(readFileSync(join(hooksDir(repo), "pre-commit"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
  });

  it("hands the pushed refs to a chained pre-push hook", () => {
    const repo = makeRepo();
    const remote = makeBareRemote();
    git(repo, "remote", "add", "origin", remote);
    const seen = join(repo, "refs-seen");
    executable(join(hooksDir(repo), "pre-push"), `#!/bin/sh\ncat > "${seen}"\n`);
    pipeline(repo, ["hooks", "install"]);
    expect(git(repo, "push", "-q", "origin", "main").status).toBe(0);
    expect(readFileSync(seen, "utf8")).toContain("refs/heads/main");
  });
});

describe("the installed pre-commit hook", () => {
  it("blocks a commit that holds a planted secret", () => {
    const repo = installed();
    stage(repo, "src/a.ts", `const k = "${planted.awsKey}";\n`);
    const before = git(repo, "rev-parse", "HEAD").stdout;
    const result = git(repo, "commit", "-q", "-m", "feat: a");
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("aws-access-key");
    expect(git(repo, "rev-parse", "HEAD").stdout).toBe(before);
  });

  it("blocks a commit that adds a .env", () => {
    const repo = installed();
    stage(repo, ".env", "A=1\n");
    expect(git(repo, "commit", "-q", "-m", "chore: env").status).not.toBe(0);
  });

  it("lets a clean commit through", () => {
    const repo = installed();
    stage(repo, "src/a.ts", "export const a = 1;\n");
    expect(git(repo, "commit", "-q", "-m", "feat: a").status).toBe(0);
  });

  it("lets an allowlisted fixture and a placeholder .env.example through", () => {
    const repo = installed();
    write(repo, ".pipeline/secrets-allow", "tests/fixtures/**\n");
    stage(repo, "tests/fixtures/leak.ts", `const k = "${planted.awsKey}";\n`);
    stage(repo, ".env.example", "API_KEY=your-key-here\n");
    expect(git(repo, "commit", "-q", "-m", "test: fixtures").status).toBe(0);
  });
});

describe("the installed pre-push hook", () => {
  function withRemote() {
    const repo = installed();
    const remote = makeBareRemote();
    git(repo, "remote", "add", "origin", remote);
    return { repo, remote };
  }

  function remoteHead(remote: string, branch: string): string {
    return git(remote, "rev-parse", "--verify", "-q", `refs/heads/${branch}`).stdout.trim();
  }

  it("blocks the push when an earlier commit holds a secret that a later commit removed", () => {
    const { repo, remote } = withRemote();
    expect(git(repo, "push", "-q", "origin", "main").status).toBe(0);
    stage(repo, "src/a.ts", `const k = "${planted.githubToken}";\n`);
    const leaking = commit(repo, "feat: a");
    stage(repo, "src/a.ts", "const k = process.env.TOKEN;\n");
    commit(repo, "fix: remove token");
    const result = git(repo, "push", "origin", "main");
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(leaking.slice(0, 8));
    expect(remoteHead(remote, "main")).not.toBe(git(repo, "rev-parse", "HEAD").stdout.trim());
  });

  it("blocks a new branch whose own commits hold a secret", () => {
    const { repo, remote } = withRemote();
    expect(git(repo, "push", "-q", "origin", "main").status).toBe(0);
    git(repo, "checkout", "-q", "-b", "feature");
    stage(repo, "src/a.ts", `const k = "${planted.anthropicKey}";\n`);
    commit(repo, "feat: a");
    expect(git(repo, "push", "origin", "feature").status).not.toBe(0);
    expect(remoteHead(remote, "feature")).toBe("");
  });

  it("lets a clean push through, including a new branch", () => {
    const { repo, remote } = withRemote();
    expect(git(repo, "push", "-q", "origin", "main").status).toBe(0);
    git(repo, "checkout", "-q", "-b", "feature");
    stage(repo, "src/a.ts", "export const a = 1;\n");
    commit(repo, "feat: a");
    expect(git(repo, "push", "-q", "origin", "feature").status).toBe(0);
    expect(remoteHead(remote, "feature")).not.toBe("");
  });

  it("does not rescan history that is already on a remote branch", () => {
    const { repo } = withRemote();
    stage(repo, "legacy.ts", `const k = "${planted.awsKey}";\n`);
    commit(repo, "feat: legacy");
    // Pushed before the hooks existed, so a new branch from it must not trip on it.
    expect(git(repo, "push", "-q", "--no-verify", "origin", "main").status).toBe(0);
    git(repo, "checkout", "-q", "-b", "feature");
    stage(repo, "src/a.ts", "export const a = 1;\n");
    commit(repo, "feat: a");
    expect(git(repo, "push", "-q", "origin", "feature").status).toBe(0);
  });

  it("lets a branch deletion through", () => {
    const { repo, remote } = withRemote();
    git(repo, "checkout", "-q", "-b", "feature");
    stage(repo, "src/a.ts", "export const a = 1;\n");
    commit(repo, "feat: a");
    expect(git(repo, "push", "-q", "origin", "feature").status).toBe(0);
    expect(git(repo, "push", "-q", "origin", "--delete", "feature").status).toBe(0);
    expect(remoteHead(remote, "feature")).toBe("");
  });
});

describe("hooks status", () => {
  it("reports nothing installed in a fresh repo and exits 1", () => {
    const { stdout, status } = pipeline(makeRepo(), ["hooks", "status"]);
    expect(status).toBe(1);
    expect(stdout).toMatch(/pre-commit\s+not installed/);
    expect(stdout).toMatch(/pre-push\s+not installed/);
  });

  it("reports both hooks once installed and exits 0", () => {
    const { stdout, status } = pipeline(installed(), ["hooks", "status"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/pre-commit\s+installed/);
    expect(stdout).toMatch(/pre-push\s+installed/);
  });

  it("notes a chained hook", () => {
    const repo = makeRepo();
    executable(join(hooksDir(repo), "pre-push"), "#!/bin/sh\nexit 0\n");
    pipeline(repo, ["hooks", "install"]);
    const { stdout } = pipeline(repo, ["hooks", "status"]);
    expect(stdout).toMatch(/pre-push\s+installed.*chains pre-push\.local/);
  });

  it("flags a foreign hook that the pipeline does not own", () => {
    const repo = makeRepo();
    executable(join(hooksDir(repo), "pre-commit"), "#!/bin/sh\nexit 0\n");
    const { stdout, status } = pipeline(repo, ["hooks", "status"]);
    expect(status).toBe(1);
    expect(stdout).toMatch(/pre-commit\s+other hook/);
  });

  it("emits JSON", () => {
    const { stdout } = pipeline(installed(), ["hooks", "status", "--json"]);
    const record = JSON.parse(stdout);
    expect(record.hooks.map((h: { name: string; state: string }) => `${h.name}:${h.state}`)).toEqual([
      "pre-commit:installed",
      "pre-push:installed",
    ]);
  });
});
