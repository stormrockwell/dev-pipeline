import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { hookNames, MARKER, scriptFor, type HookName } from "./scripts.ts";

const usage = `Usage: pipeline hooks <install | status> [--json]

Manages the git hooks that run the secret scan before anything leaves the machine.

  install   Write .git/hooks/pre-commit (pipeline secrets --staged) and .git/hooks/pre-push
            (pipeline secrets --range for each pushed ref). A hook that is already there is kept
            as <hook>.local and runs after the scan, so installing never overwrites it silently.
            Running install again updates the pipeline's own hooks in place.
  status    Report what is installed. Exits 0 when both hooks are in place, 1 otherwise.

Hooks live in the directory that git reports for hooks, so core.hooksPath is honoured.

Fresh clones need the hooks too. Have the package manager install them, for example:

  package.json    "scripts": { "prepare": "pipeline hooks install" }
  composer.json   "scripts": { "post-install-cmd": "pipeline hooks install",
                               "post-update-cmd": "pipeline hooks install" }

The prepare script runs after \`npm install\`, so a fresh clone is protected after its first install.`;

type State = "installed" | "not installed" | "other hook";

interface HookReport {
  name: HookName;
  state: State;
  path: string;
  chained: boolean;
}

function hooksDirectory(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--git-path", "hooks"], { cwd, encoding: "utf8" });
  return result.status === 0 ? resolve(cwd, result.stdout.trim()) : null;
}

function isOurs(path: string): boolean {
  return readFileSync(path, "utf8").includes(MARKER);
}

function inspect(dir: string, name: HookName): HookReport {
  const path = join(dir, name);
  const chained = existsSync(`${path}.local`);
  if (!existsSync(path)) return { name, state: "not installed", path, chained };
  return { name, state: isOurs(path) ? "installed" : "other hook", path, chained };
}

function install(dir: string, bin: string): number {
  let failed = false;
  for (const name of hookNames) {
    const path = join(dir, name);
    const kept = `${path}.local`;
    if (existsSync(path) && !isOurs(path)) {
      if (existsSync(kept)) {
        console.error(
          `pipeline hooks: ${name} already exists and so does ${name}.local, so nothing was changed. Merge them by hand, then run install again.`,
        );
        failed = true;
        continue;
      }
      renameSync(path, kept);
      console.log(`kept the existing ${name} as ${name}.local, which runs after the scan`);
    }
    writeFileSync(path, scriptFor(name, bin));
    chmodSync(path, 0o755);
    console.log(`installed ${name}`);
  }
  return failed ? 1 : 0;
}

function status(dir: string, json: boolean): number {
  const reports = hookNames.map((name) => inspect(dir, name));
  if (json) {
    console.log(JSON.stringify({ hooks: reports }, null, 2));
  } else {
    const width = Math.max(...hookNames.map((name) => name.length));
    for (const report of reports) {
      const note = report.chained && report.state === "installed" ? `, chains ${report.name}.local` : "";
      console.log(`${report.name.padEnd(width)}  ${report.state}${note}`);
    }
  }
  return reports.every((report) => report.state === "installed") ? 0 : 1;
}

async function run(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: { json: { type: "boolean" } }; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: { json: { type: "boolean" } }, allowPositionals: true });
  } catch (error) {
    console.error(`pipeline hooks: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const [subcommand] = parsed.positionals;
  if (subcommand !== "install" && subcommand !== "status") {
    console.error('pipeline hooks: expected "install" or "status". Run "pipeline hooks --help".');
    return 2;
  }

  const dir = hooksDirectory(process.cwd());
  if (!dir) {
    console.error("pipeline hooks: this is not a git repository.");
    return 1;
  }
  return subcommand === "install" ? install(dir, resolve(process.argv[1] ?? "pipeline")) : status(dir, parsed.values.json === true);
}

const command: Command = {
  name: "hooks",
  summary: "Install and inspect the git hooks that scan for secrets.",
  usage,
  run,
};

export default command;
