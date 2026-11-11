import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import type { RecordJson } from "../pr-body/auditors.ts";
import { securityStatus, statusCall } from "./status.ts";

const usage = `Usage: pipeline security-status <work-order.md> [--pr <name>] [--sha <sha>] [--repo <owner/repo>] [--dir <repo>]

Prints the one \`gh api\` call that posts the pipeline/security commit status for the pushed head.
The state is success when every task's security gate in the PR passed at its task's head, and
failure otherwise, with a description naming the gate that is missing, failed or stale. It posts
nothing, so the finish skill runs the printed call once, after the developer said yes to the push.

Options:
  --pr <name>        The PR in the plan's split. Needed when the plan has more than one.
  --sha <sha>        The pushed head. Defaults to HEAD in --dir.
  --repo <owner/repo>  Where the status goes. Defaults to the origin remote of --dir.
  --dir <repo>       The PR's worktree. Defaults to the current directory.

Exit codes: 0 when the call is printed, 2 for bad usage.`;

const bin = fileURLToPath(new URL("../../../bin/pipeline", import.meta.url));

function fail(message: string): number {
  console.error(`pipeline security-status: ${message}`);
  return 2;
}

/**
 * The owner and repo of a GitHub remote url, in https or ssh form
 */
function repoOf(url: string): string | null {
  return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1] ?? null;
}

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { pr: { type: "string" }, sha: { type: "string" }, repo: { type: "string" }, dir: { type: "string" } }, allowPositionals: true });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline security-status --help".`);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) return fail("give one work order file.");
  const file = resolve(positionals[0]!);
  const dir = resolve(values.dir ?? process.cwd());
  if (!existsSync(file)) return fail(`no work order at ${file}.`);
  if (!existsSync(join(dirname(file), "plan.json"))) return fail(`no plan.json beside the work order, so run \`pipeline schedule ${positionals[0]}\` first.`);

  let sha = values.sha;
  if (sha === undefined) {
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
    sha = head.status === 0 ? head.stdout.trim() : undefined;
  }
  if (sha === undefined || !/^[0-9a-f]{7,40}$/.test(sha)) return fail("--sha is a commit hash, and HEAD gave none.");

  let repo = values.repo;
  if (repo === undefined) {
    const origin = spawnSync("git", ["remote", "get-url", "origin"], { cwd: dir, encoding: "utf8" });
    repo = origin.status === 0 ? (repoOf(origin.stdout) ?? undefined) : undefined;
  }
  if (repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail("name the repo with --repo <owner/repo>, because origin is not a GitHub remote.");

  const recorded = spawnSync(process.execPath, [bin, "gate-record", file, ...(values.pr ? ["--pr", values.pr] : []), "--json"], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (recorded.status !== 0) return fail(`gate-record failed: ${(recorded.stderr || recorded.stdout).trim()}`);
  console.log(statusCall(repo, sha, securityStatus(JSON.parse(recorded.stdout) as RecordJson)));
  return 0;
}

const command: Command = {
  name: "security-status",
  summary: "Print the gh api call that posts the pipeline/security commit status for the pushed head.",
  usage,
  run,
};

export default command;
