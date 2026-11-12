import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { cachePath, CACHE_DIR, fetchRepo, gh, GhError, readCache, repoOfRemote, type RepoData, writeCache } from "../../compound/github.ts";
import { quality, renderQuality } from "../../compound/quality.ts";
import { readLedger } from "../../ledger/ledger.ts";
import { efficiency, type Ledger, renderEfficiency } from "../../run/efficiency.ts";
import { listLogs, primaryCheckout, readLog, RUNS_DIR, type RunLog } from "../../run/log.ts";
import { transcriptLog } from "../../run/transcript.ts";
import { fileUsage, runFile } from "./file.ts";
import { excludeLocally } from "../../task/git.ts";
import { builtinConfig, loadConfig } from "../scan-zones/config.ts";

const usage = `Usage: pipeline compound efficiency [--transcripts <dir>] [--since <date>] [--min-streams <n>] [--top <n>] [--out <file>] [--json]
       pipeline compound quality [--repo <owner/name>]... [--since <date>] [--window <days>] [--top <n>] [--offline] [--out <file>] [--json]
${fileUsage}

efficiency reads what slowed the pipeline down from the run logs in ${RUNS_DIR}/ and the ledgers in
.pipeline/work/*/ledger.jsonl: each stage's working time, waits on a person, the slowest steps,
review rounds and cap hits, agents a Stop hook sent back, failed commands and their retries,
sessions whose route changed, spend per dispatched role, repeated tool-call sequences, and the
files many agents read. A stream is the tool calls of one session's main thread or one subagent.

quality reads what slipped through from each repo's merged PRs through \`gh api\`: the gate record
in each body, human review comments told apart from agent comments and the author's replies, later
\`fix:\` commits on the PR's files, reverts, and gates a PR skipped before a fix landed on it. It
clusters the signals into missed classes by the reviewer axis that should have caught them and the
zone or review rule of the code, and ranks them. Each fetch is kept in ${CACHE_DIR}/.

Options:
  --transcripts <dir>  efficiency: read the Claude Code transcripts in <dir>, with their subagents,
                       in place of the run logs. Claude Code keeps a project's under ~/.claude/projects/.
  --since <date>       Only activity on or after this date, as YYYY-MM-DD. quality defaults to 30
                       days ago, efficiency to everything.
  --min-streams <n>    efficiency: how many streams a sequence or read must recur in. Defaults to 2.
  --repo <owner/name>  quality: a GitHub repo to read, repeatable. Defaults to this checkout's origin.
  --window <days>      quality: how long after a merge a fix still counts against the PR. Defaults to 14.
  --offline            quality: read the last fetch from ${CACHE_DIR}/ in place of GitHub.
  --top <n>            Rows per list. Defaults to 10.
  --out <file>         Also write the report as JSON to <file>, for the half's analyst.
  --json               Print the report as JSON.

Exit codes: 0 on success, 2 for bad usage, nothing to read, text refused as private, or gh unable to read or write a repo.`;

/**
 * Prints a usage error and returns its exit code
 */
function fail(message: string): number {
  console.error(`pipeline compound: ${message}`);
  return 2;
}

/**
 * A positive whole number option, or its default when absent
 */
function count(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`--${name} takes a positive whole number.`);
  return Number(value);
}

/**
 * A YYYY-MM-DD option as a time, its fallback when absent, or NaN when it is not a date
 */
function date(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
}

/**
 * The ledger of every work order in the repo
 */
function ledgers(repo: string): Ledger[] {
  const dir = join(repo, ".pipeline", "work");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "ledger.jsonl")))
    .map((entry) => ({ work: entry.name, entries: readLedger(join(dir, entry.name, "work-order.md")) }));
}

/**
 * Whether a log has an event on or after a time
 */
function since(log: RunLog, from: number): boolean {
  return log.events.some((event) => Date.parse(event.at) >= from);
}

/**
 * Writes a report as JSON, keeping one inside the repo's pipeline folder out of git
 *
 * A report there is local working state, like the run logs and PR data it came from.
 */
function writeReport(repo: string | null, file: string, report: unknown): void {
  const out = resolve(file);
  mkdirSync(dirname(out), { recursive: true });
  if (repo !== null && out.startsWith(join(repo, ".pipeline") + sep)) excludeLocally(repo, `${relative(repo, dirname(out))}/`, relative(repo, out));
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}

/**
 * Runs `pipeline compound efficiency`
 */
async function runEfficiency(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { transcripts: { type: "string" }, since: { type: "string" }, "min-streams": { type: "string" }, top: { type: "string" }, out: { type: "string" }, json: { type: "boolean" } },
    });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline compound --help".`);
  }
  const { values } = parsed;

  let minStreams: number;
  let top: number;
  try {
    minStreams = count(values["min-streams"], 2, "min-streams");
    top = count(values.top, 10, "top");
  } catch (error) {
    return fail((error as Error).message);
  }
  const from = date(values.since, 0);
  if (Number.isNaN(from)) return fail("--since takes a date as YYYY-MM-DD.");

  const repo = primaryCheckout(resolve(process.cwd()));
  let logs: RunLog[];
  if (values.transcripts !== undefined) {
    const dir = resolve(values.transcripts);
    if (!existsSync(dir)) return fail(`no transcript folder at ${dir}.`);
    logs = readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => transcriptLog(join(dir, name)));
  } else {
    if (repo === null) return fail(`${process.cwd()} is not inside a git repo.`);
    logs = listLogs(repo).map(readLog);
  }
  logs = logs.filter((log) => log.events.length > 0 && since(log, from));
  if (logs.length === 0) return fail(values.transcripts !== undefined ? "no transcripts with activity to read." : `no run logs in ${RUNS_DIR} yet. The plugin's hooks write them as sessions run.`);

  const report = efficiency(logs, repo === null ? [] : ledgers(repo), { roots: { repo }, minStreams, top });
  if (values.out !== undefined) writeReport(repo, values.out, report);
  console.log(values.json ? JSON.stringify(report, null, 2) : renderEfficiency(report));
  return 0;
}

/**
 * The GitHub repo of a checkout's origin remote, or null
 */
function originRepo(checkout: string): string | null {
  const url = spawnSync("git", ["remote", "get-url", "origin"], { cwd: checkout, encoding: "utf8" });
  return url.status === 0 ? repoOfRemote(url.stdout) : null;
}

/**
 * Runs `pipeline compound quality`
 */
async function runQuality(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        repo: { type: "string", multiple: true },
        since: { type: "string" },
        window: { type: "string" },
        top: { type: "string" },
        offline: { type: "boolean" },
        out: { type: "string" },
        json: { type: "boolean" },
      },
    });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline compound --help".`);
  }
  const { values } = parsed;

  let windowDays: number;
  let top: number;
  try {
    windowDays = count(values.window, 14, "window");
    top = count(values.top, 10, "top");
  } catch (error) {
    return fail((error as Error).message);
  }
  const from = date(values.since, Date.now() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from)) return fail("--since takes a date as YYYY-MM-DD.");

  const checkout = primaryCheckout(resolve(process.cwd()));
  const own = checkout === null ? null : originRepo(checkout);
  const names = values.repo ?? (own === null ? [] : [own]);
  if (names.length === 0) return fail("this checkout has no GitHub origin, so name a repo with --repo <owner/name>.");
  const bad = names.find((name) => !/^[\w.-]+\/[\w.-]+$/.test(name));
  if (bad !== undefined) return fail(`--repo takes owner/name, not "${bad}".`);

  const repos: RepoData[] = [];
  for (const name of names) {
    if (values.offline) {
      const cached = checkout === null ? null : readCache(checkout, name);
      if (cached === null) return fail(`no saved fetch of ${name}${checkout === null ? "" : ` at ${cachePath(checkout, name)}`}, so run once without --offline.`);
      repos.push({ ...cached, prs: cached.prs.filter((pr) => Date.parse(pr.mergedAt) >= from) });
      continue;
    }
    // A repo's own sensitive.yml applies only to the checkout it sits in, and other repos get the built-in packs.
    const config = checkout !== null && name === own ? loadConfig(checkout) : builtinConfig();
    try {
      const data = await fetchRepo(gh, name, new Date(from), config);
      if (checkout !== null) {
        excludeLocally(checkout, `${CACHE_DIR}/`, relative(checkout, cachePath(checkout, name)));
        writeCache(checkout, data);
      }
      repos.push(data);
    } catch (error) {
      if (error instanceof GhError) return fail(error.message);
      throw error;
    }
  }

  const report = quality(repos, { windowDays, top });
  if (values.out !== undefined) writeReport(checkout, values.out, report);
  console.log(values.json ? JSON.stringify(report, null, 2) : renderQuality(report));
  return 0;
}

/**
 * Runs `pipeline compound`, one half at a time
 */
async function run(argv: string[]): Promise<number> {
  const [half, ...rest] = argv;
  if (half === "efficiency") return runEfficiency(rest);
  if (half === "quality") return runQuality(rest);
  if (half === "file") return runFile(rest);
  return fail(`name the half to run, "pipeline compound quality" or "pipeline compound efficiency", or "pipeline compound file" to file a lesson. Run "pipeline compound --help".`);
}

const command: Command = {
  name: "compound",
  summary: "Mine merged PRs for what slipped through and run logs for what slowed the pipeline down, and file the lessons.",
  usage,
  run,
};

export default command;
