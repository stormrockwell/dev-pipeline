import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "pipeline");
const commandsDir = join(root, "src", "commands");

function pipeline(...args: string[]) {
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: 20_000 });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

const requiredCommands = [
  "check",
  "classify",
  "scan-zones",
  "comment-lint",
  "pr-check",
  "version-sync",
  "review-package",
  "design-diff",
  "docs",
  "doctor",
  "clean",
];

const commandNames = readdirSync(commandsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe("command discovery", () => {
  const fixture = "zz-fixture";
  const fixtureDir = join(commandsDir, fixture);

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("ships every planned command", () => {
    expect(commandNames).toEqual(expect.arrayContaining(requiredCommands));
  });

  it("lists every command directory in --help with its summary", () => {
    const { stdout, status } = pipeline("--help");
    expect(status).toBe(0);
    for (const name of commandNames) {
      const source = readFileSync(join(commandsDir, name, "index.ts"), "utf8");
      const summary = /(?:summary:\s*|stub\("[^"]+",\s*)"([^"]+)"/.exec(source)?.[1];
      expect(stdout).toMatch(new RegExp(`^\\s+${name}\\s+\\S`, "m"));
      if (summary) expect(stdout).toContain(summary);
    }
  });

  it("picks up a new command directory without any registry edit", () => {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      join(fixtureDir, "index.ts"),
      `export default {
  name: "${fixture}",
  summary: "Fixture command.",
  async run() {
    console.log("fixture ran");
    return 0;
  },
};
`,
    );
    expect(pipeline("--help").stdout).toContain("Fixture command.");
    const run = pipeline(fixture);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("fixture ran\n");
  });
});

describe("help output", () => {
  it("prints the command list when run with no arguments", () => {
    const { stdout, status } = pipeline();
    expect(status).toBe(0);
    expect(stdout).toContain("Usage: pipeline <command>");
  });

  it("prints a command's usage for <cmd> --help", () => {
    const { stdout, status } = pipeline("doctor", "--help");
    expect(status).toBe(0);
    expect(stdout).toContain("Usage: pipeline doctor");
  });
});

describe("unknown commands", () => {
  it("exits 1 with a one-line error", () => {
    const { stdout, stderr, status } = pipeline("nope");
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(stderr).toContain("nope");
  });
});

describe("stub commands", () => {
  const stubs = commandNames.filter((name) =>
    readFileSync(join(commandsDir, name, "index.ts"), "utf8").includes("stub("),
  );

  it("covers the planned commands", () => {
    expect(stubs.length).toBeGreaterThan(0);
  });

  it.each(requiredCommands.filter((name) => stubs.includes(name)))(
    "%s prints one not-built line and exits 2",
    (name) => {
      const { stdout, status } = pipeline(name);
      expect(status).toBe(2);
      expect(stdout.trimEnd().split("\n")).toHaveLength(1);
      expect(stdout).toContain("not built yet");
    },
  );
});
