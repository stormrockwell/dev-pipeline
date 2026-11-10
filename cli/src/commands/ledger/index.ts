import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { appendEntry, complete, type Entry, type GateResult, lastTask, ledgerPath, readLedger } from "../../ledger/ledger.ts";
import type { Plan } from "../schedule/plan.ts";
import { parseWorkOrder, type WorkOrder } from "../schedule/work-order.ts";

const usage = `Usage: pipeline ledger <work-order.md>
       pipeline ledger rule <work-order.md> --decided <what> --why <why> --cost <cost if wrong> [--task <id>]
       pipeline ledger gate <work-order.md> --task <id> --gate <name> --result <pass|fail|skip> [--note <text>]

The ledger is the build's memory, kept beside the work order at .pipeline/work/<slug>/ledger.jsonl.
It outlives a compacted context, so trust it and git log over what you remember.

  (no verb)   Print each task's latest result, the rulings, the gate results and the next task.
  rule        Record a decision taken on the developer's behalf, why, and what it costs if wrong.
  gate        Record a gate's result for a task, such as a review that passed or a skip with its reason.

\`pipeline task-check\` records each task's result when its check passes.

Exit codes: 0 on success, 2 for bad usage or a work order it cannot read.`;

const RESULTS: GateResult[] = ["pass", "fail", "skip"];

function fail(message: string): number {
  console.error(`pipeline ledger: ${message}`);
  return 2;
}

/**
 * The tasks in the order the schedule runs them, or the file's order before any schedule
 */
function taskOrder(file: string, order: WorkOrder): string[] {
  const planFile = join(dirname(file), "plan.json");
  if (!existsSync(planFile)) return order.tasks.map((task) => task.id);
  const plan = JSON.parse(readFileSync(planFile, "utf8")) as Plan;
  const waves = plan.order.waves.flat();
  return [...waves, ...order.tasks.map((task) => task.id).filter((id) => !waves.includes(id))];
}

function taskLine(entry: Extract<Entry, { kind: "task" }> | undefined): string {
  if (!entry) return "not started";
  const commits = entry.base === entry.head ? "no commits" : `${entry.base.slice(0, 7)}..${entry.head.slice(0, 7)}`;
  return [entry.status, entry.branch ?? "detached", commits, entry.evidence].join(", ");
}

/**
 * The ledger as a few lines: tasks, rulings, gates and what comes next
 */
function render(file: string, order: WorkOrder, entries: Entry[]): string {
  const ids = taskOrder(file, order);
  const label = (name: string) => name.padEnd(8);
  const lines = [`${label("Ledger")}${order.title}`];
  for (const id of ids) lines.push(`${label(`Task ${id}`)}${taskLine(lastTask(entries, id))}`);
  for (const entry of entries) {
    if (entry.kind === "ruling") lines.push(`${label("Ruling")}${entry.task ? `task ${entry.task}: ` : ""}${entry.decided}. Why: ${entry.why}. Cost if wrong: ${entry.cost}.`);
    if (entry.kind === "gate") lines.push(`${label("Gate")}task ${entry.task} ${entry.gate} ${entry.result}${entry.note ? `: ${entry.note}` : ""}`);
  }
  const done = (id: string) => complete(lastTask(entries, id));
  const needs = new Map(order.tasks.map((task) => [task.id, task.needs]));
  const next = ids.find((id) => !done(id) && (needs.get(id) ?? []).every(done));
  const open = ids.filter((id) => !done(id));
  lines.push(`${label("Next")}${next ? `task ${next}` : open.length === 0 ? "none, every task is done" : `none ready, task ${open.join(", ")} waits on another task`}`);
  return lines.join("\n");
}

/**
 * A sentence fragment for the ledger line, without the full stop render adds
 */
function phrase(value: string | undefined): string {
  return (value ?? "").trim().replace(/\.+$/, "");
}

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        decided: { type: "string" },
        why: { type: "string" },
        cost: { type: "string" },
        task: { type: "string" },
        gate: { type: "string" },
        result: { type: "string" },
        note: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline ledger --help".`);
  }
  const { values, positionals } = parsed;
  const verb = positionals[0] === "rule" || positionals[0] === "gate" ? positionals[0] : null;
  const rest = verb ? positionals.slice(1) : positionals;
  if (rest.length !== 1) return fail("give one work order file.");
  const file = resolve(rest[0]!);
  if (!existsSync(file)) return fail(`no work order at ${file}.`);
  let order;
  try {
    order = parseWorkOrder(readFileSync(file, "utf8"));
  } catch (error) {
    return fail(`${file} is not a valid work order: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (values.task !== undefined && !order.tasks.some((task) => task.id === values.task)) return fail(`the work order has no task ${values.task}.`);
  const at = new Date().toISOString();

  if (verb === "rule") {
    const [decided, why, cost] = [phrase(values.decided), phrase(values.why), phrase(values.cost)];
    if (!decided || !why || !cost) return fail("a ruling needs --decided, --why and --cost.");
    appendEntry(file, { kind: "ruling", at, task: values.task ?? null, decided, why, cost });
    console.log(`pipeline ledger: recorded the ruling in ${ledgerPath(file)}`);
    return 0;
  }
  if (verb === "gate") {
    const result = values.result as GateResult | undefined;
    if (values.task === undefined || !values.gate?.trim() || result === undefined) return fail("a gate needs --task, --gate and --result.");
    if (!RESULTS.includes(result)) return fail(`--result is pass, fail or skip, not "${values.result}".`);
    if (result === "skip" && !values.note?.trim()) return fail("a skipped gate needs --note with the reason.");
    appendEntry(file, { kind: "gate", at, task: values.task, gate: values.gate.trim(), result, note: values.note?.trim() || null });
    console.log(`pipeline ledger: recorded ${values.gate.trim()} ${result} for task ${values.task}`);
    return 0;
  }
  console.log(render(file, order, readLedger(file)));
  return 0;
}

const command: Command = {
  name: "ledger",
  summary: "Print or add to a work order's ledger: task results, rulings and gate results.",
  usage,
  run,
};

export default command;
