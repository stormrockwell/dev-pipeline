import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { findTask, TASK_DIR, taskPaths } from "../../task/record.ts";
import { checkTask, type CheckResult } from "./checks.ts";

const MAX_BLOCKS = 3;

const usage = `Usage: pipeline task-check [--task <dir>] [--hook]

Checks a briefed task against the implementer's report contract:

  Report     ${TASK_DIR}/report.md starts with a Status line. BLOCKED and NEEDS_CONTEXT pass at once.
  Commits    the work is committed on the task's branch, and nothing is left uncommitted.
  Files      every changed file is owned by the task or named in the report.
  Evidence   on a TDD tier, a red run came before a green run, and the green run tested HEAD's code.
  Comments   comment-lint finds no temporal, reviewer-addressed or dashed comments in the commits.

Options:
  --task <dir>   The task's worktree. Defaults to the repo holding the current directory.
  --hook         Run as a Claude Code SubagentStop hook. It reads the hook JSON on stdin, finds the
                 task from its cwd or the reply's "Task: <worktree>" line, and blocks the stop with the
                 problems. After ${MAX_BLOCKS} blocks in a row it lets the implementer stop, so a stuck agent hands back.

Exit codes: 0 when the task passes, 1 when it has problems, 2 for bad usage or no briefed task.
With --hook it always exits 0 and answers in JSON.`;

interface HookInput {
  cwd?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

function summary(result: CheckResult): string {
  const { record, status } = result;
  if (status === "BLOCKED" || status === "NEEDS_CONTEXT") return `task-check: passed, task ${record.id} is ${status}, so it hands back to the orchestrator`;
  const evidence = record.tdd.required ? "with red then green evidence" : `TDD not required because ${record.tdd.reason}`;
  return `task-check: passed, task ${record.id} is ${status}${record.tdd.required ? " " : ", "}${evidence}`;
}

function problems(result: CheckResult): string {
  return [`task-check: task ${result.record.id} is not ready`, ...result.problems.map((problem) => `- ${problem}`)].join("\n");
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The worktree a SubagentStop hook is about
 *
 * The hook's cwd may be the session root rather than the worktree, so the reply's Task line is the fallback.
 */
function hookTask(input: HookInput, task: string | undefined): string | null {
  if (task !== undefined) return findTask(resolve(task));
  const fromCwd = input.cwd ? findTask(input.cwd) : null;
  if (fromCwd !== null) return fromCwd;
  const line = /^\W*Task:\W*\s*(\/\S.*?)\s*$/m.exec(input.last_assistant_message ?? "");
  return line ? findTask(line[1]!.replace(/[`*]+$/, "")) : null;
}

/**
 * Answers a SubagentStop hook
 *
 * A failing task counts its blocks in the task folder, and the count bounds the loop where
 * stop_hook_active alone would allow one retry. A passing task resets it.
 */
async function hook(task: string | undefined): Promise<number> {
  let input: HookInput;
  try {
    input = JSON.parse((await readStdin()) || "{}") as HookInput;
  } catch {
    input = {};
  }
  const worktree = hookTask(input, task);
  if (worktree === null) {
    if (!input.stop_hook_active) {
      const reason =
        "pipeline task-check could not find your task. End your reply with the line `Task: <worktree>` from your brief, or run `pipeline task-check --task <worktree>` and fix what it finds.";
      console.log(JSON.stringify({ decision: "block", reason }));
    }
    return 0;
  }

  const result = checkTask(worktree);
  const counter = taskPaths(worktree).blocks;
  if (result.problems.length === 0) {
    rmSync(counter, { force: true });
    return 0;
  }
  const blocks = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) || 0 : 0) + 1;
  writeFileSync(counter, String(blocks));
  if (blocks > MAX_BLOCKS) {
    const systemMessage = `pipeline task-check still fails for task ${result.record.id} after ${MAX_BLOCKS} tries, so the implementer stopped with:\n${result.problems.map((problem) => `- ${problem}`).join("\n")}`;
    console.log(JSON.stringify({ systemMessage }));
    return 0;
  }
  const reason = `${problems(result)}\n\nFix these, run \`pipeline task-check --task ${worktree}\` until it passes, then finish. If you are stuck, set the report's status to BLOCKED or NEEDS_CONTEXT and say why.`;
  console.log(JSON.stringify({ decision: "block", reason }));
  return 0;
}

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { task: { type: "string" }, hook: { type: "boolean" } } });
  } catch (error) {
    console.error(`pipeline task-check: ${error instanceof Error ? error.message : String(error)}. Run "pipeline task-check --help".`);
    return 2;
  }
  const { values } = parsed;
  if (values.hook) return hook(values.task);

  const where = values.task ?? process.cwd();
  const worktree = findTask(resolve(where));
  if (worktree === null) {
    console.error(`pipeline task-check: no briefed task in ${where}, so run \`pipeline brief\` for the task first.`);
    return 2;
  }
  const result = checkTask(worktree);
  console.log(result.problems.length === 0 ? summary(result) : problems(result));
  return result.problems.length === 0 ? 0 : 1;
}

const command: Command = {
  name: "task-check",
  summary: "Check a briefed task against the report contract, alone or as a SubagentStop hook.",
  usage,
  run,
};

export default command;
