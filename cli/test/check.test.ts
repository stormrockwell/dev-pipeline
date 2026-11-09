import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "pipeline");
const scratch = mkdtempSync(join(tmpdir(), "pipeline-check-"));

interface Behavior {
  exit?: number;
  stdout?: string;
  stderr?: string;
  sleepMs?: number;
  pidFile?: string;
  /** Makes `gitleaks dir --help` fail, as it does on a gitleaks older than 8.19. */
  legacy?: boolean;
}

interface Call {
  args: string[];
  cwd: string;
}

let counter = 0;
let repo = "";
let fakes = "";

function fresh(): void {
  counter += 1;
  repo = join(scratch, `repo-${counter}`);
  fakes = join(scratch, `bin-${counter}`);
  mkdirSync(repo, { recursive: true });
  mkdirSync(fakes, { recursive: true });
}

/** Writes a node script with an absolute shebang, so the fake needs nothing else on PATH. */
function fakeAt(dir: string, name: string, behavior: Behavior = {}): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  const log = `${file}.log`;
  writeFileSync(
    file,
    `#!${process.execPath}
const fs = require("node:fs");
const b = ${JSON.stringify(behavior)};
const args = process.argv.slice(2);
if (b.legacy && args[0] === "dir" && args.includes("--help")) process.exit(1);
if (args.includes("--help") || args.includes("--version")) process.exit(0);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (b.pidFile) fs.writeFileSync(b.pidFile, String(process.pid));
if (b.stdout) process.stdout.write(b.stdout);
if (b.stderr) process.stderr.write(b.stderr);
if (b.sleepMs) setTimeout(() => process.exit(b.exit ?? 0), b.sleepMs);
else process.exit(b.exit ?? 0);
`,
  );
  chmodSync(file, 0o755);
  return file;
}

function fake(name: string, behavior: Behavior = {}): string {
  return fakeAt(fakes, name, behavior);
}

function calls(file: string): Call[] {
  const log = `${file}.log`;
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Call);
}

function touch(path: string, content = ""): void {
  const file = join(repo, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function check(...args: string[]) {
  const result = spawnSync(process.execPath, [bin, "check", ...args], {
    encoding: "utf8",
    cwd: repo,
    env: { PATH: fakes, HOME: scratch },
    timeout: 30_000,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

interface JsonResult {
  tool: string;
  status: string;
  exitCode: number | null;
  summary: string;
}

function json(...args: string[]) {
  const run = check("--json", ...args);
  const parsed = JSON.parse(run.stdout) as { ok: boolean; tools: JsonResult[] };
  return { ...run, parsed, names: parsed.tools.map((entry) => entry.tool) };
}

function lineFor(stdout: string, tool: string): string {
  return stdout.split("\n").find((line) => line.toLowerCase().includes(tool.toLowerCase())) ?? "";
}

beforeEach(fresh);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("detection", () => {
  it("runs only semgrep and gitleaks in an empty repo", () => {
    expect(json().names).toEqual(["semgrep", "gitleaks", "axe"]);
  });

  it("detects phpcs from composer.json", () => {
    touch("composer.json", "{}");
    const phpcs = fake("phpcs");
    const { names } = json();
    expect(names).toContain("phpcs");
    expect(calls(phpcs)).toHaveLength(1);
  });

  it("detects phpcs from phpcs.xml and phpcs.xml.dist", () => {
    touch("phpcs.xml");
    expect(json().names).toContain("phpcs");
    fresh();
    touch("phpcs.xml.dist");
    expect(json().names).toContain("phpcs");
  });

  it("detects phpstan from phpstan.neon and phpstan.neon.dist", () => {
    touch("phpstan.neon");
    expect(json().names).toContain("phpstan");
    fresh();
    touch("phpstan.neon.dist");
    expect(json().names).toContain("phpstan");
  });

  it("runs psalm with taint analysis when psalm.xml exists", () => {
    touch("psalm.xml");
    const psalm = fake("psalm");
    expect(json().names).toContain("psalm");
    expect(calls(psalm)[0].args).toContain("--taint-analysis");
  });

  it("detects eslint from a package.json with an eslint config file", () => {
    touch("package.json", "{}");
    touch("eslint.config.js");
    expect(json().names).toContain("eslint");
  });

  it("detects eslint from the eslintConfig key in package.json", () => {
    touch("package.json", JSON.stringify({ eslintConfig: { root: true } }));
    expect(json().names).toContain("eslint");
  });

  it("skips eslint when package.json has no eslint config", () => {
    touch("package.json", "{}");
    expect(json().names).not.toContain("eslint");
  });

  it("detects stylelint from a config file", () => {
    touch(".stylelintrc.json", "{}");
    expect(json().names).toContain("stylelint");
    fresh();
    touch("stylelint.config.js");
    expect(json().names).toContain("stylelint");
  });

  it("detects composer audit from composer.lock", () => {
    touch("composer.lock", "{}");
    const composer = fake("composer");
    expect(json().names).toContain("composer-audit");
    expect(calls(composer)[0].args).toEqual(["audit"]);
  });

  it("runs npm audit without dev dependencies when package-lock.json exists", () => {
    touch("package-lock.json", "{}");
    const npm = fake("npm");
    expect(json().names).toContain("npm-audit");
    expect(calls(npm)[0].args).toEqual(["audit", "--omit=dev"]);
  });

  it("runs the tools inside the repo", () => {
    touch("psalm.xml");
    const psalm = fake("psalm");
    const other = join(scratch, "elsewhere");
    mkdirSync(other, { recursive: true });
    const run = spawnSync(process.execPath, [bin, "check", "--path", repo], {
      encoding: "utf8",
      cwd: other,
      env: { PATH: fakes },
      timeout: 30_000,
    });
    expect(run.status).toBe(0);
    expect(calls(psalm)[0].cwd).toBe(realpathSync(repo));
  });

  it("fails with one stderr line when --path is not a directory", () => {
    const { status, stderr } = check("--path", join(scratch, "nope"));
    expect(status).toBe(1);
    expect(stderr.trimEnd().split("\n")).toHaveLength(1);
  });
});

describe("binary resolution", () => {
  it("prefers vendor/bin over PATH", () => {
    touch("phpcs.xml");
    const global = fake("phpcs");
    const local = fakeAt(join(repo, "vendor", "bin"), "phpcs");
    check();
    expect(calls(local)).toHaveLength(1);
    expect(calls(global)).toHaveLength(0);
  });

  it("prefers node_modules/.bin over PATH", () => {
    touch("package.json", "{}");
    touch("eslint.config.js");
    const global = fake("eslint");
    const local = fakeAt(join(repo, "node_modules", ".bin"), "eslint");
    check();
    expect(calls(local)).toHaveLength(1);
    expect(calls(global)).toHaveLength(0);
  });

  it("falls back to PATH when the project has no binary", () => {
    touch("phpcs.xml");
    const global = fake("phpcs");
    check();
    expect(calls(global)).toHaveLength(1);
  });
});

describe("semgrep and gitleaks", () => {
  it("passes the three rule packs to semgrep", () => {
    const semgrep = fake("semgrep");
    check();
    const args = calls(semgrep)[0].args;
    expect(args.slice(0, 1)).toEqual(["scan"]);
    for (const pack of ["p/php", "p/javascript", "p/secrets"]) {
      expect(args[args.indexOf(pack) - 1]).toBe("--config");
    }
  });

  it("uses gitleaks dir when the installed version has it", () => {
    const gitleaks = fake("gitleaks");
    check();
    expect(calls(gitleaks)[0].args[0]).toBe("dir");
  });

  it("falls back to gitleaks detect --no-git on an older version", () => {
    const gitleaks = fake("gitleaks", { legacy: true });
    check();
    const args = calls(gitleaks)[0].args;
    expect(args[0]).toBe("detect");
    expect(args).toContain("--no-git");
  });
});

describe("per-tool lines", () => {
  it("prints one passed line per tool that ran", () => {
    touch("phpcs.xml");
    fake("phpcs");
    fake("semgrep");
    fake("gitleaks");
    const { stdout, status } = check();
    expect(status).toBe(0);
    for (const tool of ["phpcs", "semgrep", "gitleaks"]) {
      expect(lineFor(stdout, tool)).toMatch(/pass/i);
    }
  });

  it("prints a failed line with the first output lines", () => {
    touch("phpcs.xml");
    fake("phpcs", { exit: 2, stdout: "FOUND 3 ERRORS AFFECTING 2 LINES\nsecond\n" });
    const { stdout, status } = check();
    expect(status).toBe(1);
    const line = lineFor(stdout, "phpcs");
    expect(line).toMatch(/fail/i);
    expect(line).toContain("exit 2");
    expect(line).toContain("FOUND 3 ERRORS");
  });

  it("falls back to stderr when a failing tool prints nothing on stdout", () => {
    touch("phpcs.xml");
    fake("phpcs", { exit: 1, stderr: "bad config\n" });
    expect(lineFor(check().stdout, "phpcs")).toContain("bad config");
  });

  it("prints a missing line with an install hint", () => {
    const line = lineFor(check().stdout, "semgrep");
    expect(line).toMatch(/missing/i);
    expect(line).toContain("brew install semgrep");
  });

  it("keeps each tool on a single line", () => {
    fake("semgrep", { exit: 1, stdout: "a\nb\nc\nd\n" });
    const lines = check().stdout.trimEnd().split("\n");
    expect(lines.filter((line) => /semgrep/i.test(line))).toHaveLength(1);
  });

  it("lists axe as not run by check", () => {
    const line = lineFor(check().stdout, "axe");
    expect(line).toContain("not run by check");
  });
});

describe("exit codes", () => {
  it("exits 0 when everything that ran passed", () => {
    fake("semgrep");
    fake("gitleaks");
    expect(check().status).toBe(0);
  });

  it("exits 0 locally when tools are missing, with a warning", () => {
    const { status, stdout } = check();
    expect(status).toBe(0);
    expect(stdout).toMatch(/warning/i);
  });

  it("exits 1 when any tool failed", () => {
    fake("semgrep");
    fake("gitleaks", { exit: 1 });
    expect(check().status).toBe(1);
  });

  it("exits 1 for missing tools with --ci", () => {
    fake("semgrep");
    const { status, stdout } = check("--ci");
    expect(status).toBe(1);
    expect(lineFor(stdout, "gitleaks")).toMatch(/missing/i);
  });

  it("exits 0 with --ci when everything is installed and passes", () => {
    fake("semgrep");
    fake("gitleaks");
    expect(check("--ci").status).toBe(0);
  });

  it("does not count axe as a missing tool under --ci", () => {
    fake("semgrep");
    fake("gitleaks");
    expect(json("--ci").parsed.ok).toBe(true);
  });
});

describe("--json", () => {
  it("prints tool, status, exitCode and summary for each tool", () => {
    touch("phpcs.xml");
    fake("phpcs", { exit: 1, stdout: "nope\n" });
    fake("semgrep");
    const { parsed, status } = json();
    expect(status).toBe(1);
    expect(parsed.ok).toBe(false);
    const byName = Object.fromEntries(parsed.tools.map((entry) => [entry.tool, entry]));
    expect(byName.phpcs).toEqual({ tool: "phpcs", status: "failed", exitCode: 1, summary: expect.stringContaining("nope") });
    expect(byName.semgrep).toMatchObject({ status: "passed", exitCode: 0 });
    expect(byName.gitleaks).toMatchObject({ status: "missing", exitCode: null });
    expect(byName.axe).toMatchObject({ status: "not-run", exitCode: null });
    for (const entry of parsed.tools) expect(typeof entry.summary).toBe("string");
  });

  it("prints only the JSON document on stdout", () => {
    const { stdout } = check("--json");
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it("reports ok false for missing tools only under --ci", () => {
    expect(json().parsed.ok).toBe(true);
    expect(json("--ci").parsed.ok).toBe(false);
  });
});

describe("timeouts", () => {
  it("counts a timeout as a failure and kills the tool", () => {
    const pidFile = join(scratch, `pid-${counter}`);
    fake("semgrep", { sleepMs: 60_000, pidFile });
    fake("gitleaks");
    const started = Date.now();
    const { parsed, status } = json("--timeout", "0.5");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(status).toBe(1);
    const semgrep = parsed.tools.find((entry) => entry.tool === "semgrep");
    expect(semgrep).toMatchObject({ status: "failed", exitCode: null });
    expect(semgrep?.summary).toMatch(/timed out/i);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("keeps running the remaining tools after a timeout", () => {
    fake("semgrep", { sleepMs: 60_000 });
    const gitleaks = fake("gitleaks");
    check("--timeout", "0.5");
    expect(calls(gitleaks)).toHaveLength(1);
  });

  it("rejects a non-positive or non-numeric --timeout", () => {
    for (const value of ["0", "-3", "soon"]) {
      const { status, stderr } = check("--timeout", value);
      expect(status).toBe(1);
      expect(stderr).toContain("--timeout");
    }
  });
});

describe("usage", () => {
  it("documents the flags in --help", () => {
    const { stdout, status } = check("--help");
    expect(status).toBe(0);
    for (const flag of ["--path", "--ci", "--json", "--timeout"]) expect(stdout).toContain(flag);
  });

  it("rejects unknown options with one stderr line", () => {
    const { status, stderr } = check("--bogus");
    expect(status).toBe(1);
    expect(stderr.trimEnd().split("\n")).toHaveLength(1);
  });
});
