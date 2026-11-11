import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { appendEntry, type GateResult } from "../../ledger/ledger.ts";
import { primaryCheckout } from "../../run/log.ts";
import { gitOut } from "../../task/git.ts";
import { findTask, readRecord, taskPaths } from "../../task/record.ts";
import { testCommand } from "../../task/test-command.ts";
import { loadConfig as loadZones } from "../scan-zones/config.ts";
import { loadConfig, readEnvFile } from "../worktree/config.ts";
import { planMutants, type MutationPlan } from "./plan.ts";
import type { Mutant } from "./rules.ts";
import { makeScratch } from "./scratch.ts";

export const GATE = "mutation check";

const usage = `Usage: pipeline mutate [--task <dir>] [--timeout <secs>] [--max <n>] [--dry-run]

Checks that a zone task's security tests bite. It finds each security check in the lines the task
changed, such as current_user_can, wp_verify_nonce, check_ajax_referer, a permission_callback or a
JS auth guard, then disables them one at a time in a scratch copy of the worktree and runs the
task's test command once per mutant. Some test must fail for each one. A mutant that leaves the
tests green survived, which means no test proves that check.

It runs the unmutated copy first, because a suite that already fails would "kill" every mutant. The
worktree itself is never edited, and the scratch copy is deleted when the run ends.

The result goes in the work order's ledger as the "mutation check" gate, so \`pipeline gate-record\` shows it and a
failed result holds the PR. The gate fails closed: a missing or broken test command, a failing
baseline, a survivor, or more mutants than --max all fail it. A task that is neither T3 nor in a
zone skips the gate. Security lines no rule can mutate are listed and do not fail the gate.

Options:
  --task <dir>      The task's worktree. Defaults to the repo holding the current directory.
  --timeout <secs>  Limit for each test run. Defaults to 300. A mutant whose run times out counts as killed.
  --max <n>         Most mutants to run. Defaults to 20. The rest are listed and fail the gate.
  --dry-run         List the mutants without running anything or recording a result.

Exit codes: 0 when every mutant was killed or the task has no zone code, 1 when the gate fails, 2 for
bad usage or no briefed task.`;

interface Outcome {
  mutant: Mutant;
  killed: boolean;
  timedOut: boolean;
  exit: number | null;
}

interface Report {
  task: string;
  head: string;
  baseline: "pass" | "fail" | "not run";
  outcomes: Outcome[];
  skipped: Mutant[];
  unmutated: MutationPlan["unmutated"];
  problem: string | null;
}

function fail(message: string): number {
  console.error(`pipeline mutate: ${message}`);
  return 2;
}

function where(mutant: Mutant): string {
  return `${mutant.file}:${mutant.line}`;
}

/**
 * Parses a positive whole number option
 */
function positive(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} needs a positive whole number, not "${value}"`);
  return number;
}

/**
 * The gate's result and the line `pipeline gate-record` shows for it
 */
function verdict(report: Report): { result: GateResult; note: string } {
  const survivors = report.outcomes.filter((outcome) => !outcome.killed);
  const killed = report.outcomes.length - survivors.length;
  const unmutated = report.unmutated.length > 0 ? `. ${report.unmutated.length} security lines had no mutation rule: ${report.unmutated.slice(0, 3).map((entry) => `${entry.file}:${entry.line}`).join(" ")}` : "";
  if (report.problem !== null) return { result: "fail", note: report.problem };
  if (survivors.length > 0) {
    const named = survivors.slice(0, 3).map((outcome) => `${where(outcome.mutant)} ${outcome.mutant.check}`);
    return { result: "fail", note: `${survivors.length} of ${report.outcomes.length} mutants survived: ${named.join("; ")}${unmutated}` };
  }
  if (report.skipped.length > 0) return { result: "fail", note: `${report.skipped.length} mutants were over the cap and never ran, so raise --max${unmutated}` };
  if (report.outcomes.length === 0) return { result: "pass", note: `no security checks in the changed lines${unmutated}` };
  return { result: "pass", note: `${killed} of ${report.outcomes.length} mutants killed${unmutated}` };
}

/**
 * The report as text, one line per mutant with the file, line, check and mutation
 */
function render(report: Report): string[] {
  const lines = [`pipeline mutate: task ${report.task}, baseline ${report.baseline}, ${report.outcomes.length} mutants run`];
  for (const outcome of report.outcomes) {
    const status = outcome.killed ? (outcome.timedOut ? "KILLED (timed out)" : "KILLED") : "SURVIVED";
    lines.push(`  ${status}  ${where(outcome.mutant)}  ${outcome.mutant.check}  ${outcome.mutant.mutation}`);
  }
  for (const mutant of report.skipped) lines.push(`  NOT RUN   ${where(mutant)}  ${mutant.check}  over the cap`);
  for (const entry of report.unmutated) lines.push(`  NO RULE   ${entry.file}:${entry.line}  ${entry.zone}  ${entry.text}`);
  return lines;
}

/**
 * Runs the test command in a directory and reports how it ended
 */
function suite(argv: string[], env: NodeJS.ProcessEnv, cwd: string, timeout: number): { exit: number | null; timedOut: boolean; broken: string | null } {
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd, env, encoding: "utf8", timeout: timeout * 1000, maxBuffer: 64 * 1024 * 1024 });
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const didNotRun = result.status === 126 || result.status === 127 || (result.error !== undefined && !timedOut);
  return { exit: result.status, timedOut, broken: didNotRun ? `the test command did not run${result.error ? ` (${result.error.message})` : ""}` : null };
}

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { task: { type: "string" }, timeout: { type: "string" }, max: { type: "string" }, "dry-run": { type: "boolean" } } });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline mutate --help".`);
  }
  const { values } = parsed;
  let timeout: number;
  let max: number;
  try {
    timeout = values.timeout === undefined ? 300 : positive(values.timeout, "--timeout");
    max = values.max === undefined ? 20 : positive(values.max, "--max");
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}.`);
  }

  const worktree = findTask(resolve(values.task ?? process.cwd()));
  if (worktree === null) return fail(`no briefed task in ${values.task ?? process.cwd()}, so run \`pipeline brief\` for the task first.`);
  const record = readRecord(worktree);
  const head = gitOut(worktree, ["rev-parse", "HEAD"]);
  const dry = values["dry-run"] === true;

  const recordGate = (result: GateResult, note: string): void => {
    if (dry) return;
    if (existsSync(record.workOrder)) {
      appendEntry(record.workOrder, { kind: "gate", at: new Date().toISOString(), task: record.id, gate: GATE, result, note, head });
    } else console.error(`pipeline mutate: no work order at ${record.workOrder}, so the result is not in the ledger.`);
  };

  if (record.tier !== "T3" && record.zones.length === 0) {
    console.log(`pipeline mutate: task ${record.id} is ${record.tier} with no zones, so the mutation check does not apply.`);
    recordGate("skip", `${record.tier} with no zones`);
    return 0;
  }

  const report: Report = { task: record.id, head, baseline: "not run", outcomes: [], skipped: [], unmutated: [], problem: null };
  const finish = (): number => {
    const { result, note } = verdict(report);
    for (const line of render(report)) console.log(line);
    console.log(`pipeline mutate: ${GATE} ${result}, ${note}.`);
    if (!dry) {
      mkdirSync(taskPaths(worktree).dir, { recursive: true });
      writeFileSync(join(taskPaths(worktree).dir, "mutation.json"), `${JSON.stringify({ ...report, result, note }, null, 2)}\n`);
    }
    recordGate(result, note);
    return result === "fail" ? 1 : 0;
  };

  let plan: MutationPlan;
  try {
    plan = planMutants(worktree, record.base, loadZones(worktree));
  } catch (error) {
    report.problem = `the changed lines could not be read: ${error instanceof Error ? error.message : String(error)}`;
    return finish();
  }
  report.unmutated = plan.unmutated;
  const queued = plan.mutants.slice(0, max);
  report.skipped = plan.mutants.slice(max);

  if (dry) {
    for (const mutant of queued) console.log(`  WOULD RUN  ${where(mutant)}  ${mutant.check}  ${mutant.mutation}`);
    for (const mutant of report.skipped) console.log(`  OVER CAP   ${where(mutant)}  ${mutant.check}`);
    for (const entry of plan.unmutated) console.log(`  NO RULE    ${entry.file}:${entry.line}  ${entry.zone}  ${entry.text}`);
    console.log(`pipeline mutate: ${plan.mutants.length} mutants, ${plan.unmutated.length} security lines with no rule. Nothing ran.`);
    return 0;
  }

  if (queued.length === 0) return finish();
  if (record.test === null) {
    report.problem = "the brief recorded no test command, so no mutant can be checked and the gate stays closed";
    return finish();
  }

  let resolved;
  let env: NodeJS.ProcessEnv;
  try {
    resolved = testCommand(record.test, [], worktree);
    const fileEnv = readEnvFile(join(worktree, loadConfig(primaryCheckout(worktree) ?? worktree).database.envFile));
    env = { ...process.env, ...fileEnv, ...resolved.env };
  } catch (error) {
    report.problem = `the test command will not run: ${error instanceof Error ? error.message : String(error)}`;
    return finish();
  }

  let scratch: string | null = null;
  try {
    scratch = makeScratch(worktree);
    const baseline = suite(resolved.argv, env, scratch, timeout);
    if (baseline.broken !== null || baseline.timedOut || baseline.exit !== 0) {
      report.baseline = "fail";
      report.problem = baseline.broken ?? (baseline.timedOut ? "the unmutated tests timed out" : `the unmutated tests failed with exit ${baseline.exit}, so a failing mutant would prove nothing`);
      return finish();
    }
    report.baseline = "pass";

    for (const mutant of queued) {
      const path = join(scratch, mutant.file);
      const original = readFileSync(path, "utf8");
      const lines = original.split("\n");
      if (lines[mutant.line - 1]?.replace(/\r$/, "") !== mutant.original) {
        report.problem = `${where(mutant)} changed between planning and the run, so rerun the check`;
        return finish();
      }
      lines[mutant.line - 1] = mutant.mutated + (lines[mutant.line - 1]!.endsWith("\r") ? "\r" : "");
      writeFileSync(path, lines.join("\n"));
      let ran;
      try {
        ran = suite(resolved.argv, env, scratch, timeout);
      } finally {
        writeFileSync(path, original);
      }
      if (ran.broken !== null) {
        report.problem = `${ran.broken} for the mutant at ${where(mutant)}`;
        return finish();
      }
      report.outcomes.push({ mutant, killed: ran.timedOut || ran.exit !== 0, timedOut: ran.timedOut, exit: ran.exit });
    }
  } catch (error) {
    report.problem = `the scratch run failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  }
  return finish();
}

const command: Command = {
  name: "mutate",
  summary: "Disable each security check in a scratch copy and fail when no test notices.",
  usage,
  run,
};

export default command;
