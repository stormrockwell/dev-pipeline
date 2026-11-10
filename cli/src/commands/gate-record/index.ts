import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { readLedger } from "../../ledger/ledger.ts";
import { listLogs, primaryCheckout, readLog } from "../../run/log.ts";
import { duration, summarize, touches } from "../../run/summary.ts";
import type { Plan } from "../schedule/plan.ts";
import { buildRecord, type GateRecord, hiddenComment } from "./record.ts";

const usage = `Usage: pipeline gate-record <work-order.md> [--pr <name>] [--json | --comment]

Builds the gate record of a work order, or of one PR in its split: each task's result, every gate
its tier requires with its result from the ledger, the rulings, and what the run cost in tokens,
stage time and waits on a person, from the run logs of the sessions that touched the work.

It writes the record beside the work order, as gate-record.json, or gate-record-<pr>.json with --pr.
A gate nobody recorded is pending. TDD passes from the task's passing check.

Options:
  --pr <name>   Only the tasks of this PR, as \`pipeline schedule\` named it.
  --json        Print the record as JSON.
  --comment     Print the record as the hidden HTML comment that goes at the end of the PR body.

Exit codes: 0 on success, 2 for bad usage or a work order with no plan.json.`;

function fail(message: string): number {
  console.error(`pipeline gate-record: ${message}`);
  return 2;
}

/**
 * The record as a few lines for the build summary
 */
function render(record: GateRecord, path: string): string {
  const label = (name: string) => name.padEnd(8);
  const lines = [`${label("Record")}${record.work}${record.pr ? ` PR ${record.pr}` : ""}, written to ${path}`];
  for (const task of record.tasks) {
    const gates = record.gates.filter((gate) => gate.task === task.id).map((gate) => `${gate.gate} ${gate.result}`);
    lines.push(`${label(`Task ${task.id}`)}${task.status ?? "not done"}, ${task.tier}${gates.length > 0 ? `. ${gates.join(", ")}` : ""}`);
  }
  for (const waived of record.accepted) lines.push(`${label("Waived")}task ${waived.task} ${waived.gate}, ${waived.finding}: ${waived.reason}`);
  if (record.findings.opened > 0) lines.push(`${label("Findings")}${record.findings.opened} opened, ${record.findings.fixed} fixed, ${record.findings.accepted} waived`);
  const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;
  const parts = [
    `main ${record.cost.main.model ?? "unknown"} ${k(record.cost.main.tokens)}`,
    ...record.cost.dispatches.map((dispatch) => `${dispatch.type}${dispatch.task ? ` task ${dispatch.task}` : ""} ${dispatch.model ?? "unknown"} ${k(dispatch.tokens)}`),
  ];
  lines.push(`${label("Cost")}${k(record.cost.tokens)} tokens: ${parts.join(", ")}`);
  if (record.stages.length > 0) lines.push(`${label("Stages")}${record.stages.map((stage) => `${stage.name} ${duration(stage.ms)}`).join(", ")}`);
  lines.push(`${label("Waits")}${record.waits.count} on a person, ${duration(record.waits.ms)}`);
  return lines.join("\n");
}

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { pr: { type: "string" }, json: { type: "boolean" }, comment: { type: "boolean" } }, allowPositionals: true });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline gate-record --help".`);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) return fail("give one work order file.");
  if (values.json && values.comment) return fail("give --json or --comment, not both.");
  const file = resolve(positionals[0]!);
  const planFile = join(dirname(file), "plan.json");
  if (!existsSync(file)) return fail(`no work order at ${file}.`);
  if (!existsSync(planFile)) return fail(`no plan.json beside the work order, so run \`pipeline schedule ${positionals[0]}\` first.`);
  const plan = JSON.parse(readFileSync(planFile, "utf8")) as Plan;
  if (values.pr !== undefined && !plan.prs.some((pr) => pr.name === values.pr)) {
    return fail(`the plan has no PR ${values.pr}. Its PRs are ${plan.prs.map((pr) => pr.name).join(", ")}.`);
  }

  const work = basename(dirname(file));
  const repo = primaryCheckout(dirname(file));
  const logs = repo === null ? [] : listLogs(repo).map(readLog).filter((log) => touches(log, work));
  const runs = logs.length > 0 ? summarize(logs) : null;
  if (runs) runs.dispatches = runs.dispatches.filter((dispatch) => dispatch.work === work);

  const record = buildRecord(file, plan, readLedger(file), runs, values.pr ?? null);
  const out = join(dirname(file), values.pr ? `gate-record-${values.pr}.json` : "gate-record.json");
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(values.json ? JSON.stringify(record, null, 2) : values.comment ? hiddenComment(record) : render(record, out));
  return 0;
}

const command: Command = {
  name: "gate-record",
  summary: "Build a work order's gate record from its plan, ledger and run logs, as JSON or a hidden PR comment.",
  usage,
  run,
};

export default command;
