import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { recordHook, type HookInput } from "../../run/hook.ts";
import { listLogs, logPath, primaryCheckout, readLog, RUNS_DIR } from "../../run/log.ts";
import { renderSummary, summarize, touches } from "../../run/summary.ts";

const usage = `Usage: pipeline run-log [--session <id> | --work <slug>] [--json]
       pipeline run-log --hook

Summarizes the event logs Claude Code sessions write to ${RUNS_DIR}/<session>.jsonl: each stage's
working time, each dispatch with its model, turns and tokens, the main session's spend, tool calls
with failures, and the time spent waiting on a person.

Options:
  --session <id>   Summarize one session. Defaults to the session written last.
  --work <slug>    Summarize every session that touched .pipeline/work/<slug>/, with only that work's dispatches.
  --json           Print the summary as JSON.
  --hook           Record a Claude Code hook payload read on stdin. The plugin registers it on
                   SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure, SubagentStop,
                   Stop and SessionEnd. It writes only in a repo with a .pipeline folder, and never
                   blocks or answers.

Exit codes: 0 on success, 2 for bad usage or no logs to summarize. With --hook it always exits 0.`;

function fail(message: string): number {
  console.error(`pipeline run-log: ${message}`);
  return 2;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Records one hook payload
 *
 * A logging failure must never disturb the session, so every error ends in a silent exit 0.
 */
async function hook(): Promise<number> {
  try {
    recordHook(JSON.parse((await readStdin()) || "{}") as HookInput);
  } catch {
    // The session goes on without this event.
  }
  return 0;
}

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { hook: { type: "boolean" }, session: { type: "string" }, work: { type: "string" }, json: { type: "boolean" } } });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline run-log --help".`);
  }
  const { values } = parsed;
  if (values.hook) return hook();
  if (values.session !== undefined && values.work !== undefined) return fail("give --session or --work, not both.");

  const repo = primaryCheckout(resolve(process.cwd()));
  if (repo === null) return fail(`${process.cwd()} is not inside a git repo.`);
  const paths = listLogs(repo);
  let logs;
  if (values.session !== undefined) {
    if (!/^[\w-]+$/.test(values.session) || !paths.includes(logPath(repo, values.session))) return fail(`no log for session ${values.session} in ${RUNS_DIR}.`);
    logs = [readLog(logPath(repo, values.session))];
  } else if (values.work !== undefined) {
    const work = values.work;
    logs = paths.map(readLog).filter((log) => touches(log, work));
    if (logs.length === 0) return fail(`no session in ${RUNS_DIR} touched .pipeline/work/${work}/.`);
  } else {
    if (paths.length === 0) return fail(`no logs in ${RUNS_DIR} yet. The plugin's hooks write them as sessions run.`);
    logs = [readLog(paths[0]!)];
  }

  const summary = summarize(logs);
  if (values.work !== undefined) summary.dispatches = summary.dispatches.filter((dispatch) => dispatch.work === values.work);
  console.log(values.json ? JSON.stringify(summary, null, 2) : renderSummary(summary));
  return 0;
}

const command: Command = {
  name: "run-log",
  summary: "Record Claude Code hook events per session, and summarize stages, dispatches, cost and waits.",
  usage,
  run,
};

export default command;
