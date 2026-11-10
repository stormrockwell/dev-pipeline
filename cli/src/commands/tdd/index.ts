import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { Command } from "../../command.ts";
import { appendRun, type Phase, type Run } from "../../task/evidence.ts";
import { gitOut, workingTree } from "../../task/git.ts";
import { findTask, TASK_DIR } from "../../task/record.ts";

const usage = `Usage: pipeline tdd <red|green> [--task <dir>] [--timeout <secs>] -- <test command> [args...]

Runs the task's test command and records the run in ${TASK_DIR}/evidence.jsonl: the phase, the
command, its exit code, the last lines of output, HEAD and the working tree's id.

  red     The command must fail. A command that passes, never ran or timed out proves nothing.
  green   The command must pass. \`pipeline task-check\` counts a green run only when it tested the
          code HEAD holds, so run green after the last commit.

Options:
  --task <dir>       The task's worktree. Defaults to the repo holding the current directory.
  --timeout <secs>   Hard limit for the command. Defaults to 600. A timeout is never a red run.

Exit codes: 0 when the run is what its phase needs, 1 when it is not, 2 for bad usage or no briefed task.`;

const TAIL_LINES = 40;
// Shells exit 126 for a command that is not executable and 127 for one that does not exist.
const DID_NOT_RUN = [126, 127];

function fail(message: string): number {
  console.error(`pipeline tdd: ${message}`);
  return 2;
}

/**
 * Splits the CLI's own options from the test command after the first `--`
 */
function split(argv: string[]): { own: string[]; command: string[] } {
  const at = argv.indexOf("--");
  return at === -1 ? { own: argv, command: [] } : { own: argv.slice(0, at), command: argv.slice(at + 1) };
}

/**
 * Reads --task and --timeout from the CLI's own arguments
 */
function options(own: string[]): { phase: string | undefined; task: string | undefined; timeout: number; extra: string[] } {
  let task: string | undefined;
  let timeout = 600;
  const rest: string[] = [];
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]!;
    if (arg === "--task" || arg === "--timeout") {
      const value = own[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === "--task") task = value;
      else {
        timeout = Number(value);
        if (!Number.isFinite(timeout) || timeout <= 0) throw new Error(`"${value}" is not a positive number of seconds`);
      }
    } else rest.push(arg);
  }
  return { phase: rest[0], task, timeout, extra: rest.slice(1) };
}

/**
 * Why a run does not count for its phase, or null when it does
 */
function refusal(phase: Phase, run: Run, error: Error | undefined): string | null {
  if (error || run.exit === null || DID_NOT_RUN.includes(run.exit)) {
    return run.timedOut ? "the command timed out, so the run proves nothing" : `the command did not run${error ? ` (${error.message})` : ""}, so the run proves nothing`;
  }
  if (phase === "red" && run.exit === 0) return "the command passed, and a red run needs a failing test";
  if (phase === "green" && run.exit !== 0) return `the command failed with exit ${run.exit}, and a green run needs it to pass`;
  return null;
}

async function run(argv: string[]): Promise<number> {
  const { own, command } = split(argv);
  let parsed;
  try {
    parsed = options(own);
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline tdd --help".`);
  }
  const { phase, task, timeout, extra } = parsed;
  if (phase !== "red" && phase !== "green") return fail('give the phase, "red" or "green".');
  if (extra.length > 0) return fail(`put the test command after --, as in \`pipeline tdd ${phase} -- npm test\`.`);
  if (command.length === 0) return fail(`give the test command after --, as in \`pipeline tdd ${phase} -- npm test\`.`);

  const worktree = findTask(resolve(task ?? process.cwd()));
  if (worktree === null) return fail(`no briefed task in ${task ?? process.cwd()}, so run \`pipeline brief\` for the task first.`);

  const result = spawnSync(command[0]!, command.slice(1), {
    cwd: worktree,
    encoding: "utf8",
    timeout: timeout * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (output !== "") process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);

  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const entry: Run = {
    phase,
    command,
    exit: result.status,
    signal: result.signal,
    timedOut,
    ok: false,
    head: gitOut(worktree, ["rev-parse", "HEAD"]),
    tree: workingTree(worktree),
    tail: output.trimEnd().split("\n").slice(-TAIL_LINES).join("\n"),
    at: new Date().toISOString(),
  };
  const refused = refusal(phase, entry, timedOut ? undefined : result.error);
  entry.ok = refused === null;
  appendRun(worktree, entry);

  if (refused !== null) {
    console.log(`pipeline tdd: ${phase} not counted, ${refused}.`);
    return 1;
  }
  console.log(
    phase === "red"
      ? `pipeline tdd: red recorded, the command failed with exit ${entry.exit} as a red run should. Check the failure is the one the test means to catch.`
      : "pipeline tdd: green recorded.",
  );
  return 0;
}

const command: Command = {
  name: "tdd",
  summary: "Run a task's tests and record the red or green run as TDD evidence.",
  usage,
  run,
};

export default command;
