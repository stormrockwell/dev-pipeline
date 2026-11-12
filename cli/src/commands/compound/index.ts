import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { readLedger } from "../../ledger/ledger.ts";
import { efficiency, type Ledger, renderEfficiency } from "../../run/efficiency.ts";
import { listLogs, primaryCheckout, readLog, RUNS_DIR, type RunLog } from "../../run/log.ts";
import { transcriptLog } from "../../run/transcript.ts";
import { excludeLocally } from "../../task/git.ts";

const usage = `Usage: pipeline compound efficiency [--transcripts <dir>] [--since <date>] [--min-streams <n>] [--top <n>] [--out <file>] [--json]

Reads what slowed the pipeline down from the run logs in ${RUNS_DIR}/ and the ledgers in
.pipeline/work/*/ledger.jsonl: each stage's working time, waits on a person, the slowest steps,
review rounds and cap hits, agents a Stop hook sent back, failed commands and their retries,
sessions whose route changed, spend per dispatched role, repeated tool-call sequences, and the
files many agents read. A stream is the tool calls of one session's main thread or one subagent.

Options:
  --transcripts <dir>  Read the Claude Code transcripts in <dir>, with their subagents, in place of
                       the run logs. Claude Code keeps a project's under ~/.claude/projects/.
  --since <date>       Only sessions with activity on or after this date, as YYYY-MM-DD.
  --min-streams <n>    How many streams a sequence or read must recur in. Defaults to 2.
  --top <n>            Rows per list. Defaults to 10.
  --out <file>         Also write the report as JSON to <file>, for the efficiency analyst.
  --json               Print the report as JSON.

Exit codes: 0 on success, 2 for bad usage or nothing to read.`;

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
 * Runs `pipeline compound efficiency`
 */
async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { transcripts: { type: "string" }, since: { type: "string" }, "min-streams": { type: "string" }, top: { type: "string" }, out: { type: "string" }, json: { type: "boolean" } },
    });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline compound --help".`);
  }
  const { values, positionals } = parsed;
  if (positionals[0] !== "efficiency" || positionals.length > 1) return fail(`name the half to run: "pipeline compound efficiency". Run "pipeline compound --help".`);

  let minStreams: number;
  let top: number;
  try {
    minStreams = count(values["min-streams"], 2, "min-streams");
    top = count(values.top, 10, "top");
  } catch (error) {
    return fail((error as Error).message);
  }
  let from = 0;
  if (values.since !== undefined) {
    from = /^\d{4}-\d{2}-\d{2}$/.test(values.since) ? Date.parse(`${values.since}T00:00:00Z`) : NaN;
    if (Number.isNaN(from)) return fail("--since takes a date as YYYY-MM-DD.");
  }

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
  if (values.out !== undefined) {
    const out = resolve(values.out);
    mkdirSync(dirname(out), { recursive: true });
    // A report inside the repo's pipeline folder is local working state, like the run logs it came from.
    if (repo !== null && out.startsWith(join(repo, ".pipeline") + sep)) excludeLocally(repo, `${relative(repo, dirname(out))}/`, relative(repo, out));
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(values.json ? JSON.stringify(report, null, 2) : renderEfficiency(report));
  return 0;
}

const command: Command = {
  name: "compound",
  summary: "Mine run logs for what slowed the pipeline down: stage times, loops, misroutes and repeated tool-call sequences.",
  usage,
  run,
};

export default command;
