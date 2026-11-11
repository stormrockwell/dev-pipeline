import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import type { Tier } from "../classify/tier.ts";
import { higherRisk, type Risk, riskForTier, riskLabel, zoneLabel } from "../risk-gate/risk.ts";
import type { Plan } from "../schedule/plan.ts";
import { loadConfig } from "../scan-zones/config.ts";
import { isTestFile } from "../scan-zones/scan.ts";
import { repoTop } from "../secrets/git.ts";
import { auditors, failedGates, type RecordJson } from "./auditors.ts";
import { assembleBody, parseDraft, type ZoneFiles } from "./body.ts";

const usage = `Usage: pipeline pr-body <work-order.md> --draft <draft.md> --range <base>..<head> [--pr <name>] [--dir <repo>] [--out <body.md>]

Writes a PR body from the docs agent's draft and the parts a script owns. The draft starts with a
\`Title:\` line and holds What changed, Why this approach, How to verify, and Risk with its Door and
Blast radius lines. pr-body adds the rest:

  Human review   the line, and a Human review required list of zone files and lines, from
                 \`pipeline scan-zones\` over the range and the zones the plan gave the PR's tasks.
  Auditors       from a fresh gate record: Ran for passed gates, Skipped with each reason, and
                 Accepted only when a finding was dismissed.
  Record         \`Co-Authored using AI\`, then the gate record as a hidden comment.

It refuses while a task in the PR is not done in the ledger or a gate failed, then checks the body with \`pipeline pr-check\` and prints the
title and the labels the PR takes.

Options:
  --draft <file>   The docs agent's draft.
  --range <range>  The PR's commits, as <base>..<head>.
  --pr <name>      The PR in the plan's split. Needed when the plan has more than one.
  --dir <repo>     Where the range is read and zones are scanned. Defaults to the current directory.
  --out <file>     Where the body goes. Defaults to pr-<name>.md beside the work order.

Exit codes: 0 when the body passes pr-check, 1 when a task is open, a gate failed or pr-check found problems,
2 for bad usage.`;

const bin = fileURLToPath(new URL("../../../bin/pipeline", import.meta.url));

function fail(message: string): number {
  console.error(`pipeline pr-body: ${message}`);
  return 2;
}

function pipeline(args: string[], cwd: string) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

interface ScanReport {
  files: { file: string; zones: string[]; matches: { zone: string; line: number | null }[]; removed: { zone: string; line: number | null }[] }[];
}

/**
 * Zone files from the scan of the range, plus the owned files of tasks the plan put in a zone
 *
 * The plan can raise a task into a zone before any line matches a signal, and its files still need
 * the human reviewer. Its test files are left to the scan, which still lists one that matches a path
 * rule or holds a secret.
 */
function zoneFiles(scan: ScanReport, plan: Plan, tasks: string[], changed: string[], isTest: (file: string) => boolean): ZoneFiles {
  const zones: ZoneFiles = new Map();
  const add = (zone: string, file: string, line: number | null) => {
    const files = zones.get(zone) ?? new Map<string, number[]>();
    const lines = files.get(file) ?? [];
    if (line !== null) lines.push(line);
    files.set(file, lines);
    zones.set(zone, files);
  };
  for (const file of scan.files) {
    for (const match of [...file.matches, ...file.removed]) add(match.zone, file.file, match.line);
    for (const zone of file.zones) add(zone, file.file, null);
  }
  for (const task of plan.tasks.filter((entry) => tasks.includes(entry.id))) {
    for (const zone of task.zones) {
      for (const file of task.files.filter((owned) => changed.includes(owned) && !isTest(owned))) add(zone, file, null);
    }
  }
  return zones;
}

/**
 * The labels a PR takes: its highest risk, and one label per zone
 *
 * Zone code is T3 work whatever the plan said, so a zone in the scan raises the risk to high.
 */
function labels(plan: Plan, tasks: string[], peers: number, zones: ZoneFiles): string[] {
  let risk: Risk = "low";
  for (const task of plan.tasks.filter((entry) => tasks.includes(entry.id))) risk = higherRisk(risk, riskForTier(task.tier as Tier, peers >= 2));
  if (zones.size > 0) risk = higherRisk(risk, peers >= 2 ? "critical" : "high");
  return [riskLabel(risk), ...[...zones.keys()].sort().map(zoneLabel)];
}

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { draft: { type: "string" }, range: { type: "string" }, pr: { type: "string" }, dir: { type: "string" }, out: { type: "string" } },
      allowPositionals: true,
    });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline pr-body --help".`);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) return fail("give one work order file.");
  if (values.draft === undefined || values.range === undefined) return fail("give the docs agent's draft with --draft and the PR's commits with --range.");
  if (!/^[^\s.][^\s]*\.\.[^\s.][^\s]*$/.test(values.range)) return fail(`--range is <base>..<head>, not "${values.range}".`);
  const file = resolve(positionals[0]!);
  const dir = resolve(values.dir ?? process.cwd());
  const draftFile = resolve(values.draft);
  const planFile = join(dirname(file), "plan.json");
  for (const [path, what] of [[file, "work order"], [draftFile, "draft"], [planFile, "plan.json, so run `pipeline schedule` first"]] as const) {
    if (!existsSync(path)) return fail(`no ${what} at ${path}.`);
  }
  const plan = JSON.parse(readFileSync(planFile, "utf8")) as Plan;
  if (values.pr === undefined && plan.prs.length > 1) return fail(`the plan splits into PRs ${plan.prs.map((pr) => pr.name).join(", ")}, so name one with --pr.`);
  const pr = values.pr === undefined ? plan.prs[0] : plan.prs.find((entry) => entry.name === values.pr);
  if (!pr) return fail(`the plan has no PR ${values.pr}.`);

  const draft = parseDraft(readFileSync(draftFile, "utf8"));
  if (draft.title === null) return fail("the draft has no `Title:` line. Its first line is `Title: type(scope): subject`, so add it to the draft with Edit and run pr-body again.");

  const recordArgs = ["gate-record", file, ...(plan.prs.length > 1 ? ["--pr", pr.name] : []), "--comment"];
  const recorded = pipeline(recordArgs, dir);
  if (recorded.status !== 0) return fail(`gate-record failed: ${(recorded.stderr || recorded.stdout).trim()}`);
  const hidden = recorded.stdout.trim();
  const json = /<!-- pipeline:gate-record\n([\s\S]*?)\n-->/.exec(hidden)?.[1];
  if (json === undefined) return fail("gate-record printed no hidden record.");
  const record = JSON.parse(json) as RecordJson;
  const open = record.tasks.filter((task) => task.status !== "DONE" && task.status !== "DONE_WITH_CONCERNS");
  if (open.length > 0) {
    console.log(["pr-body: not written, because the PR holds tasks the ledger does not show done", ...open.map((task) => `- task ${task.id} is ${task.status ?? "not started"}`)].join("\n"));
    return 1;
  }
  const failed = failedGates(record);
  if (failed.length > 0) {
    console.log(["pr-body: not written, because a gate failed and the fix loop owns it", ...failed.map((gate) => `- ${gate}`)].join("\n"));
    return 1;
  }

  const scanned = pipeline(["scan-zones", "--range", values.range, "--path", dir, "--json"], dir);
  if (scanned.status !== 0) return fail(`scan-zones failed: ${(scanned.stderr || scanned.stdout).trim()}`);
  const diff = spawnSync("git", ["diff", "--name-only", values.range, "--"], { cwd: dir, encoding: "utf8" });
  if (diff.status !== 0) return fail(`git diff ${values.range} failed: ${(diff.stderr ?? "").trim()}`);
  const zoneConfig = loadConfig(repoTop(dir) ?? dir);
  const zones = zoneFiles(JSON.parse(scanned.stdout) as ScanReport, plan, pr.tasks, diff.stdout.split("\n").filter(Boolean), (path) => isTestFile(zoneConfig, path));

  const body = assembleBody(draft, zones, auditors(record), hidden);
  const out = resolve(values.out ?? join(dirname(file), `pr-${pr.name}.md`));
  writeFileSync(out, body);

  const checked = pipeline(["pr-check", "--file", out, "--title", draft.title], dir);
  const summary = [`Title   ${draft.title}`, `Labels  ${labels(plan, pr.tasks, pr.peers, zones).join(", ")}`, `PR      ${pr.name}`, `Base    ${values.range.split("..")[0]}${pr.stacksOn.length > 0 ? `, stacked on PR ${pr.stacksOn.join(", ")}` : ""}`];
  if (checked.status !== 0) {
    console.log([`pr-body: wrote ${out}, and pr-check found problems for the docs agent to fix`, ...checked.stdout.trim().split("\n").map((line) => `- ${line}`), ...summary].join("\n"));
    return 1;
  }
  console.log([`pr-body: wrote ${out}, and it passes pr-check`, ...summary].join("\n"));
  return 0;
}

const command: Command = {
  name: "pr-body",
  summary: "Write a PR body from the docs agent's draft, with the Human review line, Auditors and gate record generated.",
  usage,
  run,
};

export default command;
