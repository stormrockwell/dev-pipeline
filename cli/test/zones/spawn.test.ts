import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtinConfig, parseConfig } from "../../src/commands/scan-zones/config.ts";
import { scanText } from "../../src/commands/scan-zones/scan.ts";
import type { Zone } from "../../src/commands/scan-zones/types.ts";
import { root } from "../helpers/repo.ts";

const config = builtinConfig();

function zonesOf(line: string, path = "tool.js"): Zone[] {
  return scanText(config, path, `${line}\n`).zones;
}

describe("process spawning that is no longer a signal", () => {
  it.each([
    'import { spawnSync } from "node:child_process";',
    "import { spawn, execFile } from 'child_process';",
    'import type { SpawnOptions } from "node:child_process";',
    "const { spawnSync } = require('node:child_process');",
    "const { spawn, execFile } = require(\"child_process\")",
  ])("a plain import line: %s", (line) => {
    expect(zonesOf(line)).toEqual([]);
  });

  it.each([
    'const result = spawnSync("git", ["show", spec], { cwd: top });',
    "const result = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {",
    'const result = spawnSync("gh", ["pr", "view", String(prNumber)], { encoding: "utf8" });',
    'const child = spawn("git", [], { cwd });',
    'execFile("git", ["status"], callback);',
    'const out = execFileSync("git", ["rev-parse", "HEAD"]);',
    'const out = child_process_alias.spawnSync("git", ["log"]);',
    'const result = spawnSync("npm", ["audit", "--json"], { cwd });',
    'const result = spawnSync("composer", ["audit"], { cwd });',
    'spawnSync("/usr/bin/git", ["status"]);',
    "spawnSync(`git`, ['status']);",
  ])("a literal command with an argument array: %s", (line) => {
    // The alias case keeps the child_process word out of the line, so only the call decides.
    expect(zonesOf(line)).toEqual([]);
  });
});

describe("process spawning that still is a signal", () => {
  it.each([
    "const { exec: run } = require('child_process');",
    'import { exec as run } from "node:child_process";',
    "import * as cp from 'node:child_process';",
    "import cp from 'child_process';",
    "const cp = require('child_process');",
    "require('child_process').exec(cmd);",
    "} from 'node:child_process';",
    "const { exec } = require('child_process'); run();",
  ])("an import that renames or takes a member: %s", (line) => {
    expect(zonesOf(line)).toEqual(["input"]);
  });

  it.each([
    "execSync(`git log ${ref}`);",
    'execSync("git diff HEAD", { encoding: "utf8" });',
    "exec('ls ' + dir, cb);",
    "exec(cmd, cb);",
    "cp.execSync(command);",
    "const child = fork('./worker.js', [], {});",
  ])("a shell string or a fork: %s", (line) => {
    expect(zonesOf(line)).toEqual(["input"]);
  });

  it.each([
    "spawn(cmd, [dir]);",
    "spawn(binary, args, { cwd });",
    "spawnSync(file, args);",
    "spawnSync(`git ${sub}`, [dir]);",
    "execFile(program, ['--flag']);",
    'spawnSync("git", args);',
    'spawnSync("git" + suffix, ["status"]);',
    "spawnSync(",
    "const child = spawn(",
  ])("a non literal command or array: %s", (line) => {
    expect(zonesOf(line)).toEqual(["input"]);
  });

  it.each([
    'spawnSync("git", ["status"], { shell: true });',
    'spawn("git", ["status"], { cwd, shell: "/bin/sh" });',
    "const options = { cwd, shell: true };",
    "const options = { shell: useShell };",
  ])("shell: true on a call or in its options: %s", (line) => {
    expect(zonesOf(line)).toEqual(["input"]);
  });

  it.each(["const options = { shell: false };", "interface Options { shell?: boolean }"])("shell: false is not a signal: %s", (line) => {
    expect(zonesOf(line)).toEqual([]);
  });

  it.each([
    'spawnSync("sh", ["-c", script]);',
    'spawnSync("bash", ["run.sh"]);',
    "spawnSync('/bin/sh', ['-c', 'x']);",
    'spawnSync("cmd", ["/c", "dir"]);',
    'spawnSync("cmd.exe", ["/c", "dir"]);',
    'spawn("powershell", ["-Command", c]);',
    'spawnSync("node", ["-e", code]);',
    'spawnSync("python3", ["-c", code]);',
    'execFile("perl", ["-e", code]);',
    'spawnSync("env", ["FOO=1", "tool"]);',
    'spawnSync("sudo", ["tool"]);',
    'spawnSync("npx", ["some-tool"]);',
  ])("an interpreter or a launcher: %s", (line) => {
    expect(zonesOf(line)).toEqual(["input"]);
  });

  it.each([
    'spawnSync("npm", ["install"], { cwd });',
    "spawnSync('npm', ['ci']);",
    'spawnSync("npm", ["run", "build"]);',
    'spawnSync("pnpm", ["add", pkg]);',
    'spawnSync("yarn", [sub]);',
    'spawnSync("composer", ["install"], { cwd });',
    'spawnSync("composer", ["require", name]);',
    'spawnSync("pip3", ["install", "-r", file]);',
    'spawnSync("npm", [',
  ])("an installer: %s", (line) => {
    expect(zonesOf(line)).toEqual(["input"]);
  });
});

describe("what the pack still reads", () => {
  it("reports the call on a line even when the import is plain", () => {
    const content = 'import { execSync } from "node:child_process";\nexecSync(`git log ${ref}`);\n';
    expect(scanText(config, "tool.js", content).matches.map((match) => match.line)).toEqual([2]);
  });

  it("does not take a regular expression exec for child_process", () => {
    expect(zonesOf("const m = /a(b)/.exec(text);")).toEqual([]);
  });
});

describe("this repo's own sensitive.yml", () => {
  const config = parseConfig(readFileSync(join(root, "..", ".pipeline", "sensitive.yml"), "utf8"));

  it("uses the node pack and no other", () => {
    expect(config.packs).toEqual(["node"]);
  });

  it.each(["guard", "secrets", "hooks", "scan-zones", "check", "risk-gate", "github"])("puts cli/src/commands/%s in guardrails", (dir) => {
    const scan = scanText(config, `cli/src/commands/${dir}/index.ts`, "export {};\n");
    expect(scan.zones).toEqual(["guardrails"]);
    expect(scan.matches[0]!.kind).toBe("path");
  });

  it.each(["classify", "pr-check", "docs", "doctor"])("leaves cli/src/commands/%s to the content signals", (dir) => {
    expect(scanText(config, `cli/src/commands/${dir}/index.ts`, "export {};\n").zones).toEqual([]);
  });

  it("keeps the default guardrail paths", () => {
    for (const path of [".pipeline/sensitive.yml", ".github/workflows/cli.yml", ".claude/settings.json", ".github/CODEOWNERS", "cli/package.json"]) {
      expect(scanText(config, path, "x\n").zones).toEqual(["guardrails"]);
    }
  });
});
