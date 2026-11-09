import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  commit,
  executable,
  fake,
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

// Runs `pipeline secrets` and asserts that no full planted secret reached the output.
function secrets(cwd: string, args: string[], input?: string) {
  const result = pipeline(cwd, ["secrets", ...args], { input });
  for (const value of Object.values(planted)) {
    expect(result.stdout + result.stderr).not.toContain(value);
  }
  return result;
}

describe("--staged", () => {
  it("fails on a planted AWS key and reports file, line, rule and a masked value", () => {
    const repo = makeRepo();
    stage(repo, "src/config.ts", `export const a = 1;\nexport const key = "${planted.awsKey}";\n`);
    const { stdout, status } = secrets(repo, ["--staged"]);
    expect(status).toBe(1);
    expect(stdout).toContain("src/config.ts:2");
    expect(stdout).toContain("aws-access-key");
    expect(stdout).toContain(planted.awsKey.slice(0, 4) + "*");
  });

  it("passes when the staged change is clean", () => {
    const repo = makeRepo();
    stage(repo, "src/index.ts", "export const answer = 42;\n");
    const { status } = secrets(repo, ["--staged"]);
    expect(status).toBe(0);
  });

  it("ignores a secret that is in the working tree but not staged", () => {
    const repo = makeRepo();
    write(repo, "src/local.ts", `const key = "${planted.awsKey}";\n`);
    expect(secrets(repo, ["--staged"]).status).toBe(0);
  });

  it("flags only added lines, not secrets that a staged change removes", () => {
    const repo = makeRepo();
    stage(repo, "src/old.ts", `const key = "${planted.awsKey}";\n`);
    commit(repo, "feat: oops");
    stage(repo, "src/old.ts", "const key = process.env.AWS_KEY;\n");
    expect(secrets(repo, ["--staged"]).status).toBe(0);
  });

  it("fails on a new .env even when its content looks harmless", () => {
    const repo = makeRepo();
    stage(repo, ".env", "APP_NAME=demo\n");
    const { stdout, status } = secrets(repo, ["--staged"]);
    expect(status).toBe(1);
    expect(stdout).toContain(".env");
    expect(stdout).toContain("sensitive-file");
  });

  it("accepts a .env.example that holds placeholders", () => {
    const repo = makeRepo();
    stage(
      repo,
      ".env.example",
      [
        "APP_NAME=demo",
        "DB_HOST=localhost",
        "API_KEY=your-api-key-here",
        "DATABASE_PASSWORD=",
        "STRIPE_SECRET=<your-secret-key>",
        "AWS_SECRET_ACCESS_KEY=changeme-changeme-changeme",
        "",
      ].join("\n"),
    );
    expect(secrets(repo, ["--staged"]).status).toBe(0);
  });

  it("fails on a .env.example that holds a real-looking value", () => {
    const repo = makeRepo();
    stage(repo, ".env.example", `DATABASE_PASSWORD=${planted.genericSecret}\n`);
    const { stdout, status } = secrets(repo, ["--staged"]);
    expect(status).toBe(1);
    expect(stdout).toContain(".env.example:1");
  });

  it.each([
    ".env.local",
    "app/.env.production",
    "certs/server.pem",
    "certs/server.key",
    "certs/bundle.p12",
    "auth.json",
    "public/wp-config.php",
    "dump.sql",
    "backup/dump.sql.gz",
    "storage/debug.log",
    "site/wp-content/uploads/2024/05/photo.png",
  ])("blocks the sensitive path %s", (path) => {
    const repo = makeRepo();
    stage(repo, path, "harmless\n");
    const { stdout, status } = secrets(repo, ["--staged"]);
    expect(status).toBe(1);
    expect(stdout).toContain(path);
    expect(stdout).toContain("sensitive-file");
  });

  it.each(["src/environment.ts", "docs/env.md", "wp-config-sample.php", "wp-content/themes/a/style.css"])(
    "allows the ordinary path %s",
    (path) => {
      const repo = makeRepo();
      stage(repo, path, "harmless\n");
      expect(secrets(repo, ["--staged"]).status).toBe(0);
    },
  );

  it("lets a staged deletion of a sensitive file through", () => {
    const repo = makeRepo();
    stage(repo, "dump.sql", "select 1;\n");
    commit(repo, "chore: add dump");
    git(repo, "rm", "-q", "dump.sql");
    expect(secrets(repo, ["--staged"]).status).toBe(0);
  });
});

describe("built-in detectors", () => {
  const cases: [string, string, string][] = [
    ["aws-access-key", "src/a.ts", `const k = "${planted.awsKey}";`],
    ["github-token", "src/b.ts", `const token = "${planted.githubToken}";`],
    ["anthropic-key", "src/c.ts", `const k = "${planted.anthropicKey}";`],
    ["openai-key", "src/d.ts", `const k = "${planted.openaiKey}";`],
    ["private-key", "keys/id", `${planted.privateKey}\nMIIEowIBAAKCAQEA\n`],
    ["slack-token", "src/e.ts", `const t = "${planted.slackToken}";`],
    ["generic-secret", "src/f.ts", `const client_secret = "${planted.genericSecret}";`],
    ["generic-secret", "config.ini", `db_password = ${planted.genericSecret}`],
    ["high-entropy-string", "src/g.ts", `const blob = "${planted.entropyString}";`],
  ];

  it.each(cases)("detects %s in %s", (rule, path, content) => {
    const { stdout, status } = secrets(tempDir(), ["--stdin", "--path", path], content + "\n");
    expect(status).toBe(1);
    expect(stdout).toContain(rule);
    expect(stdout).toContain(`${path}:`);
  });

  it("reports the line number inside multi-line content", () => {
    const content = `a\nb\nconst k = "${planted.awsKey}";\n`;
    const { stdout } = secrets(tempDir(), ["--stdin", "--path", "src/x.ts"], content);
    expect(stdout).toContain("src/x.ts:3");
  });

  it.each([
    ["a UUID", `const id = "3f2504e0-4f5c-11ed-bdc3-0242ac120002";`],
    ["a git sha", `const sha = "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3";`],
    ["an env read", `const key = process.env.STRIPE_SECRET_KEY_LIVE_1234;`],
    ["a function call", `const token = getAccessTokenFromSession1(request);`],
    ["a placeholder", `const api_key = "your-api-key-goes-here-0000";`],
    ["a class list", `const c = "flex items-center justify-between px-4 py-2";`],
    ["the AWS documentation key", `const k = "AKIAIOSFODNN7EXAMPLE";`],
    ["an alphabet constant", `const letters = "abcdefghijklmnopqrstuvwxyz0123456789";`],
    ["a lockfile integrity hash", `"integrity": "sha512-${fake(64, 11)}",`],
  ])("does not flag %s", (_label, content) => {
    const { status } = secrets(tempDir(), ["--stdin", "--path", "src/ok.ts"], content + "\n");
    expect(status).toBe(0);
  });
});

describe("--range", () => {
  it("reports the earlier commit that holds a secret that a later commit removed", () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD").stdout.trim();
    stage(repo, "src/leak.ts", `const key = "${planted.awsKey}";\n`);
    const leaking = commit(repo, "feat: add client");
    stage(repo, "src/leak.ts", "const key = process.env.AWS_KEY;\n");
    const fix = commit(repo, "fix: drop the key");
    const { stdout, status } = secrets(repo, ["--range", `${base}..HEAD`]);
    expect(status).toBe(1);
    expect(stdout).toContain("src/leak.ts:1");
    expect(stdout).toContain(leaking.slice(0, 8));
    expect(stdout).not.toContain(fix.slice(0, 8));
  });

  it("scans every commit and names each one that holds a hit", () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD").stdout.trim();
    stage(repo, "a.ts", `const a = "${planted.awsKey}";\n`);
    const first = commit(repo, "feat: a");
    stage(repo, "b.ts", "export const b = 2;\n");
    commit(repo, "feat: b");
    stage(repo, "c.ts", `const c = "${planted.githubToken}";\n`);
    const third = commit(repo, "feat: c");
    const { stdout, status } = secrets(repo, ["--range", `${base}..HEAD`]);
    expect(status).toBe(1);
    expect(stdout).toContain(first.slice(0, 8));
    expect(stdout).toContain(third.slice(0, 8));
  });

  it("catches a sensitive file added in one commit and deleted in the next", () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD").stdout.trim();
    stage(repo, ".env", "APP=1\n");
    const adding = commit(repo, "chore: env");
    git(repo, "rm", "-q", "--cached", ".env");
    commit(repo, "chore: untrack env");
    const { stdout, status } = secrets(repo, ["--range", `${base}..HEAD`]);
    expect(status).toBe(1);
    expect(stdout).toContain(adding.slice(0, 8));
  });

  it("passes on a clean range", () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD").stdout.trim();
    stage(repo, "a.ts", "export const a = 1;\n");
    commit(repo, "feat: a");
    expect(secrets(repo, ["--range", `${base}..HEAD`]).status).toBe(0);
  });

  it("scans only commits missing from every remote branch when the pushed ref is new", () => {
    const repo = makeRepo();
    stage(repo, "old.ts", `const a = "${planted.awsKey}";\n`);
    const alreadyThere = commit(repo, "feat: already on the remote");
    const remote = makeBareRemote();
    git(repo, "remote", "add", "origin", remote);
    expect(git(repo, "push", "-q", "origin", "main").status).toBe(0);
    git(repo, "checkout", "-q", "-b", "feature");
    stage(repo, "new.ts", `const b = "${planted.githubToken}";\n`);
    const fresh = commit(repo, "feat: new work");
    const zero = "0".repeat(40);
    const { stdout, status } = secrets(repo, ["--range", `${zero}..feature`]);
    expect(status).toBe(1);
    expect(stdout).toContain(fresh.slice(0, 8));
    expect(stdout).not.toContain(alreadyThere.slice(0, 8));
  });

  it("passes for a new ref whose commits are all on the remote already", () => {
    const repo = makeRepo();
    const remote = makeBareRemote();
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "checkout", "-q", "-b", "feature");
    expect(secrets(repo, ["--range", `${"0".repeat(40)}..feature`]).status).toBe(0);
  });

  it("exits 2 for a range it cannot read", () => {
    const repo = makeRepo();
    const { status, stderr } = secrets(repo, ["--range", "nope"]);
    expect(status).toBe(2);
    expect(stderr).toContain("--range");
  });
});

describe("--stdin", () => {
  it("fails on content that holds a secret", () => {
    const { status } = secrets(tempDir(), ["--stdin", "--path", "src/a.ts"], `x = "${planted.githubToken}"\n`);
    expect(status).toBe(1);
  });

  it("passes on clean content", () => {
    expect(secrets(tempDir(), ["--stdin", "--path", "src/a.ts"], "export {};\n").status).toBe(0);
  });

  it("blocks a write to a sensitive path whatever the content", () => {
    const { stdout, status } = secrets(tempDir(), ["--stdin", "--path", "/work/app/.env"], "A=1\n");
    expect(status).toBe(1);
    expect(stdout).toContain("sensitive-file");
  });

  it("allows a write to .env.example with placeholders", () => {
    const { status } = secrets(tempDir(), ["--stdin", "--path", ".env.example"], "API_KEY=your-key-here\n");
    expect(status).toBe(0);
  });

  it("needs --path", () => {
    const { status, stderr } = secrets(tempDir(), ["--stdin"], "x\n");
    expect(status).toBe(2);
    expect(stderr).toContain("--path");
  });
});

describe("allowlist", () => {
  const leaky = `const key = "${planted.awsKey}";\n`;

  it("fails on a fixture that no allowlist covers", () => {
    const repo = makeRepo();
    stage(repo, "tests/fixtures/sample.ts", leaky);
    expect(secrets(repo, ["--staged"]).status).toBe(1);
  });

  it("passes on a fixture covered by .pipeline/secrets-allow", () => {
    const repo = makeRepo();
    write(repo, ".pipeline/secrets-allow", "# Test fixtures only.\ntests/fixtures/**\n");
    stage(repo, "tests/fixtures/sample.ts", leaky);
    stage(repo, "tests/fixtures/.env", "TOKEN=1\n");
    expect(secrets(repo, ["--staged"]).status).toBe(0);
  });

  it("keeps flagging a file outside the allowlisted globs", () => {
    const repo = makeRepo();
    write(repo, ".pipeline/secrets-allow", "tests/fixtures/**\n");
    stage(repo, "src/real.ts", leaky);
    expect(secrets(repo, ["--staged"]).status).toBe(1);
  });

  it("honours a basename glob and applies to a range", () => {
    const repo = makeRepo();
    write(repo, ".pipeline/secrets-allow", "*.fixture\n");
    const base = git(repo, "rev-parse", "HEAD").stdout.trim();
    stage(repo, "deep/dir/token.fixture", leaky);
    commit(repo, "test: fixture");
    expect(secrets(repo, ["--range", `${base}..HEAD`]).status).toBe(0);
  });
});

describe(".gitignore", () => {
  it("fails when .gitignore no longer ignores .env", () => {
    const repo = makeRepo({ gitignore: "node_modules/\n" });
    stage(repo, "src/a.ts", "export {};\n");
    const { stdout, status } = secrets(repo, ["--staged"]);
    expect(status).toBe(1);
    expect(stdout).toContain("gitignore-env");
  });

  it("fails when there is no .gitignore at all", () => {
    const repo = makeRepo();
    git(repo, "rm", "-q", ".gitignore");
    expect(secrets(repo, ["--staged"]).status).toBe(1);
  });

  it("passes when .env stays ignored", () => {
    const repo = makeRepo({ gitignore: "*.local\n.env\n" });
    stage(repo, "src/a.ts", "export {};\n");
    expect(secrets(repo, ["--staged"]).status).toBe(0);
  });
});

describe("--json", () => {
  it("emits the gate record for a hit", () => {
    const repo = makeRepo();
    stage(repo, "src/a.ts", `const k = "${planted.awsKey}";\n`);
    const { stdout, status } = secrets(repo, ["--staged", "--json"]);
    expect(status).toBe(1);
    const record = JSON.parse(stdout);
    expect(record).toMatchObject({ mode: "staged", ok: false });
    expect(record.findings).toHaveLength(1);
    expect(record.findings[0]).toMatchObject({ file: "src/a.ts", line: 1, rule: "aws-access-key" });
    expect(record.findings[0].masked).toMatch(/^AKIA\*+$/);
  });

  it("emits ok for a clean change", () => {
    const repo = makeRepo();
    stage(repo, "src/a.ts", "export {};\n");
    const record = JSON.parse(secrets(repo, ["--staged", "--json"]).stdout);
    expect(record).toMatchObject({ mode: "staged", ok: true, findings: [] });
  });

  it("records the commit for a range hit", () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD").stdout.trim();
    stage(repo, "a.ts", `const a = "${planted.awsKey}";\n`);
    const sha = commit(repo, "feat: a");
    const record = JSON.parse(secrets(repo, ["--range", `${base}..HEAD`, "--json"]).stdout);
    expect(record.findings[0].commit).toBe(sha);
  });
});

describe("usage", () => {
  it("exits 2 when no mode is given", () => {
    const { status, stderr } = secrets(makeRepo(), []);
    expect(status).toBe(2);
    expect(stderr).toContain("--staged");
  });

  it("exits 2 when two modes are given", () => {
    expect(secrets(makeRepo(), ["--staged", "--stdin", "--path", "a"]).status).toBe(2);
  });

  it("documents every mode in --help", () => {
    const { stdout, status } = pipeline(tempDir(), ["secrets", "--help"]);
    expect(status).toBe(0);
    for (const flag of ["--staged", "--range", "--stdin", "--path", "--json", "secrets-allow"]) {
      expect(stdout).toContain(flag);
    }
  });
});

describe("gitleaks", () => {
  function withFakeGitleaks(report: string): { PATH: string } {
    const dir = tempDir("pipeline-fake-gitleaks-");
    executable(
      join(dir, "gitleaks"),
      `#!/bin/sh
if [ "$1" = "version" ]; then echo 8.21.0; exit 0; fi
echo "$@" > "${dir}/args"
out=""
while [ $# -gt 0 ]; do
  case "$1" in -r|--report-path) out="$2";; esac
  shift
done
cat > "$out" <<'JSON'
${report}
JSON
exit 1
`,
    );
    return { PATH: `${dir}:${process.env.PATH ?? ""}` };
  }

  it("merges gitleaks findings with the built-in ones when it is on PATH", () => {
    const repo = makeRepo();
    const leaked = `const k = "${planted.awsKey}";\n`;
    stage(repo, "src/a.ts", leaked + "const other = 1;\n");
    stage(repo, "src/b.ts", "const b = 1;\n");
    const env = withFakeGitleaks(
      JSON.stringify([{ RuleID: "custom-rule", File: "src/b.ts", StartLine: 1, Secret: "REDACTED", Commit: "" }]),
    );
    const result = pipeline(repo, ["secrets", "--staged", "--json"], { env: { ...env } });
    expect(result.status).toBe(1);
    const rules = JSON.parse(result.stdout).findings.map((f: { rule: string; file: string }) => `${f.file}:${f.rule}`);
    expect(rules).toContain("src/b.ts:gitleaks/custom-rule");
    expect(rules).toContain("src/a.ts:aws-access-key");
  });

  it("keeps working on the built-in set when gitleaks fails to run", () => {
    const repo = makeRepo();
    stage(repo, "src/a.ts", `const k = "${planted.awsKey}";\n`);
    const dir = tempDir("pipeline-broken-gitleaks-");
    executable(join(dir, "gitleaks"), `#!/bin/sh\nif [ "$1" = version ]; then echo 8.21.0; exit 0; fi\nexit 3\n`);
    const result = pipeline(repo, ["secrets", "--staged"], { env: { PATH: `${dir}:${process.env.PATH ?? ""}` } });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("aws-access-key");
  });
});
