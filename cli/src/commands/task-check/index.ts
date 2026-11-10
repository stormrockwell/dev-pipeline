import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { appendEntry } from "../../ledger/ledger.ts";
import { gitOut } from "../../task/git.ts";
import { findTask, TASK_DIR, taskPaths } from "../../task/record.ts";
import { checkTask, type CheckResult } from "./checks.ts";

const MAX_BLOCKS = 3;

const usage = `Usage: pipeline task-check [--task <dir>] [--draft | --hook]

Checks a briefed task against the implementer's report contract:

  Report     ${TASK_DIR}/report.md starts with a Status line. BLOCKED and NEEDS_CONTEXT pass at once.
  Commits    the work is committed on the task's branch, and nothing is left uncommitted.
  Files      every changed file is owned by the task or named in the report.
  Evidence   on a TDD tier, a red run came before a green run, and the green run tested HEAD's code.
  Comments   comment-lint finds no temporal, reviewer-addressed or dashed comments in the commits.

A pass, outside --draft, records the task's status, branch and commits in the work order's ledger
at .pipeline/work/<slug>/ledger.jsonl, which \`pipeline ledger\` prints.

The report is the implementer's final reply. Claude Code refuses report files written by a subagent,
so the SubagentStop hook saves the reply to ${TASK_DIR}/report.md.

Options:
  --task <dir>   The task's worktree. Defaults to the repo holding the current directory.
  --draft        Check the work before the final reply exists, leaving out the report.
  --hook         Run as a Claude Code SubagentStop hook. It reads the hook JSON on stdin, finds the
                 task from its cwd or the reply's "Task: <worktree>" line, saves the reply as the
                 report, and blocks the stop with the problems. After ${MAX_BLOCKS} blocks in a row it lets
                 the implementer stop, so a stuck agent hands back.

Exit codes: 0 when the task passes, 1 when it has problems, 2 for bad usage or no briefed task.
With --hook it always exits 0 and answers in JSON.`;

interface HookInput {
  cwd?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

function summary(result: CheckResult, draft: boolean): string {
  const { record, status } = result;
  if (draft) {
    return ["task-check: the work passes, so start your final reply with its Status line, which becomes the report", ...result.notes.map((note) => `- ${note}`)].join("\n");
  }
  if (status === "BLOCKED" || status === "NEEDS_CONTEXT") return `task-check: passed, task ${record.id} is ${status}, so it hands back to the orchestrator`;
  const evidence = record.tdd.required ? "with red then green evidence" : `TDD not required because ${record.tdd.reason}`;
  return `task-check: passed, task ${record.id} is ${status}${record.tdd.required ? " " : ", "}${evidence}`;
}

function problems(result: CheckResult): string {
  return [`task-check: task ${result.record.id} is not ready`, ...[...result.problems, ...result.notes].map((problem) => `- ${problem}`)].join("\n");
}

/**
 * Records a passing check in the work order's ledger, so an orchestrator that lost its context knows the task is settled
 */
function settle(result: CheckResult): void {
  const { record, status } = result;
  if (status === null || !existsSync(record.workOrder)) return;
  const done = status === "DONE" || status === "DONE_WITH_CONCERNS";
  appendEntry(record.workOrder, {
    kind: "task",
    at: new Date().toISOString(),
    task: record.id,
    status,
    branch: gitOut(record.worktree, ["branch", "--show-current"]) || null,
    base: record.base,
    head: gitOut(record.worktree, ["rev-parse", "HEAD"]),
    evidence: !done ? "handed back" : record.tdd.required ? "red then green" : `TDD not required: ${record.tdd.reason}`,
  });
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
 * The latest reply replaces the saved report on every stop, so the check always reads what the
 * implementer said last. A failing task counts its blocks in the task folder, and the count bounds
 * the loop where stop_hook_active alone would allow one retry. A passing task resets it.
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
        "pipeline task-check could not find your task. End your reply with the line `Task: <worktree>` from your brief, and run `pipeline task-check --task <worktree> --draft` to fix what it finds.";
      console.log(JSON.stringify({ decision: "block", reason }));
    }
    return 0;
  }

  const paths = taskPaths(worktree);
  const reply = input.last_assistant_message?.trim();
  if (reply) writeFileSync(paths.report, `${reply}\n`);

  const result = checkTask(worktree);
  if (result.problems.length === 0) {
    rmSync(paths.blocks, { force: true });
    settle(result);
    return 0;
  }
  const blocks = (existsSync(paths.blocks) ? Number(readFileSync(paths.blocks, "utf8")) || 0 : 0) + 1;
  writeFileSync(paths.blocks, String(blocks));
  if (blocks > MAX_BLOCKS) {
    const systemMessage = `pipeline task-check still fails for task ${result.record.id} after ${MAX_BLOCKS} tries, so the implementer stopped with:\n${result.problems.map((problem) => `- ${problem}`).join("\n")}`;
    console.log(JSON.stringify({ systemMessage }));
    return 0;
  }
  const reason = `${problems(result)}\n\nFix these, run \`pipeline task-check --task ${worktree} --draft\` until it passes, then reply again. Your reply is the report, so it starts with the Status line. If you are stuck, start it with \`Status: BLOCKED\` or \`Status: NEEDS_CONTEXT\` and say why.`;
  console.log(JSON.stringify({ decision: "block", reason }));
  return 0;
}

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { task: { type: "string" }, draft: { type: "boolean" }, hook: { type: "boolean" } } });
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
  const draft = values.draft === true;
  const result = checkTask(worktree, draft);
  if (result.problems.length === 0 && !draft) settle(result);
  console.log(result.problems.length === 0 ? summary(result, draft) : problems(result));
  return result.problems.length === 0 ? 0 : 1;
}

const command: Command = {
  name: "task-check",
  summary: "Check a briefed task against the report contract, alone or as a SubagentStop hook.",
  usage,
  run,
};

export default command;
