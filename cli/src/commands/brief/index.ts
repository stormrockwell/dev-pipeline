import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { excludeLocally, gitOut } from "../../task/git.ts";
import { findTask, readRecord, TASK_DIR, taskPaths, writeRecord, type TaskRecord } from "../../task/record.ts";
import { testCommand } from "../../task/test-command.ts";
import type { Plan } from "../schedule/plan.ts";
import { parseWorkOrder } from "../schedule/work-order.ts";
import { repoTop } from "../secrets/git.ts";
import { renderBrief } from "./render.ts";
import { taskSection } from "./section.ts";

const usage = `Usage: pipeline brief <work-order.md> <task-id> [--worktree <dir>] [--test <command>] [--no-tdd <reason>]

Writes one task's brief for its implementer into the worktree, at ${TASK_DIR}/brief.md, with the
record that \`pipeline tdd\` and \`pipeline task-check\` read beside it. The brief holds the task's
section of the work order, its owned files, the tier and reviews from the last \`pipeline schedule\`,
the test-first steps, the rules and the report contract. Git ignores ${TASK_DIR}/.

Options:
  --worktree <dir>     Where the implementer works. Defaults to the current repo.
  --test <command>     The command that runs the task's tests, which \`pipeline tdd\` runs. Needed on a TDD
                       tier. It must be one plain command that \`pipeline guard\` allows.
  --no-tdd <reason>    Drop the TDD steps on a TDD tier, such as when the developer declined a harness.

Exit codes: 0 when the brief is written, 2 for bad usage, an unscheduled work order or a task it cannot brief.`;

function fail(message: string): number {
  console.error(`pipeline brief: ${message}`);
  return 2;
}

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { worktree: { type: "string" }, test: { type: "string" }, "no-tdd": { type: "string" } },
      allowPositionals: true,
    });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline brief --help".`);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 2) return fail("give a work order file and a task id.");
  const [file, id] = [resolve(positionals[0]!), positionals[1]!];

  const worktree = repoTop(resolve(values.worktree ?? process.cwd()));
  if (worktree === null) return fail(`${values.worktree ?? process.cwd()} is not inside a git repo.`);
  if (!existsSync(file)) return fail(`no work order at ${file}.`);

  const source = readFileSync(file, "utf8");
  let order;
  try {
    order = parseWorkOrder(source);
  } catch (error) {
    return fail(`${file} is not a valid work order: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const task = order.tasks.find((entry) => entry.id === id);
  if (!task) return fail(`the work order has no task ${id}.`);

  const planFile = join(dirname(file), "plan.json");
  const planned = existsSync(planFile) ? (JSON.parse(readFileSync(planFile, "utf8")) as Plan).tasks.find((entry) => entry.id === id) : undefined;
  if (!planned) return fail(`task ${id} has no tier yet, so run \`pipeline schedule ${positionals[0]}\` first.`);

  const section = taskSection(source, id);
  if (section === null) return fail(`the work order has no "## Task ${id}" section for the brief to carry.`);

  // A second brief of the same task keeps the first base, so the commits made since still count as the task's.
  let base = gitOut(worktree, ["rev-parse", "HEAD"]);
  const held = findTask(worktree);
  if (held !== null) {
    const existing = readRecord(held);
    if (existing.workOrder !== file || existing.id !== id) {
      return fail(`${worktree} already holds task ${existing.id} of ${existing.workOrder}, so brief this task in its own worktree.`);
    }
    base = existing.base;
  }

  const tddGate = planned.gates.some((gate) => gate.startsWith("TDD"));
  const declined = values["no-tdd"]?.trim();
  const test = values.test?.trim() || null;
  if (tddGate && !declined && test === null) return fail(`task ${id} is ${planned.tier} with TDD, so give the command that runs its tests with --test.`);
  if (test !== null) {
    try {
      testCommand(test, [], worktree);
    } catch (error) {
      return fail(`${error instanceof Error ? error.message : String(error)}.`);
    }
  }
  const record: TaskRecord = {
    workOrder: file,
    id,
    title: task.title,
    tier: planned.tier,
    zones: planned.zones,
    gates: planned.gates,
    files: planned.files,
    tdd: tddGate && !declined ? { required: true, reason: null } : { required: false, reason: declined || `${planned.tier} has no TDD gate` },
    test,
    base,
    worktree,
  };

  excludeLocally(worktree, `${TASK_DIR}/`, `${TASK_DIR}/task.json`);
  writeRecord(record);
  const paths = taskPaths(worktree);
  writeFileSync(paths.brief, renderBrief(record, task, section, order.title));
  console.log(`pipeline brief: wrote ${paths.brief}`);
  return 0;
}

const command: Command = {
  name: "brief",
  summary: "Write a task's brief and record into its worktree for the implementer.",
  usage,
  run,
};

export default command;
