import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { AXES, REVIEWERS, replyJson } from "../../review/findings.ts";
import { dismiss, loadContext, MAX_ROUNDS, type MergeOutcome, mergeTask, overrule, ReviewError, saveReply, securityReplyFailed, type Started, startRound, type Verifying } from "../../review/flow.ts";
import { NIT_CAP, place } from "../../review/merge.ts";
import { fileRules, OCR_PACKAGE, OCR_VERSION, renderFileRules } from "../../review/rules.ts";
import { roundPaths } from "../../review/state.ts";
import { findTask } from "../../task/record.ts";

const MAX_BLOCKS = 3;
// A security reply gets one retry, so its second failure fails the security gate and never passes it.
const MAX_SECURITY_BLOCKS = 1;

const usage = `Usage: pipeline review start <work-order.md> --task <id> [--worktree <dir>] [--continue <reason>]
       pipeline review merge <work-order.md> --task <id> [--worktree <dir>]
       pipeline review overrule <work-order.md> --task <id> --finding <id> --over <id> [--worktree <dir>]
       pipeline review dismiss <work-order.md> --task <id> --finding <id> --reason <why> [--worktree <dir>]
       pipeline review files --task <worktree> --from <ref> [--json]
       pipeline review save --hook

Runs the review rounds of one task, step 6 of the change route. Reviewers: spec, standards, the
simplifier and security, each as a plugin agent reading a package file. Findings rank by axis: ${AXES.join(", ")}.
Security runs at the depth its gate names: light and quick send one hunter and one verifier, and full
sends three hunters on opus and a vote of three verifiers.

  start     Open the next round and write a package per reviewer it routes to. The first round, a
            fix diff over a third of the original, and a fix that adds files get every reviewer the
            tier names. A smaller fix goes to each reviewer whose findings it fixes, to spec when it
            changes code beyond the named lines, and to the simplifier and standards when it adds a
            function or branch or runs past about twenty lines. Gates for reviewers this version does
            not ship are recorded as skipped. Security re-reviews every fix, and the whole task diff when
            the fix touches zone code. Past ${MAX_ROUNDS} rounds it needs --continue with the developer's reason.
  merge     Merge the round's findings: drop duplicates, send pre-existing ones and, in a fix round,
            ones off the fix diff to the backlog, cap nits at ${NIT_CAP}, list contests between axes on
            the same lines, write the fix list in precedence order, and record each reviewer's gate.
            When the security hunters reported candidates, it first writes the verifiers' packages,
            prints Verify lines and stops. With the verdicts in, a candidate a majority confirmed is
            an Important security finding with its tests on the fix list, and the rest go to the
            review guide. A missing or broken security reply fails the security gate.
  overrule  Take the lower finding of a contest off the fix list, recording the ruling.
  dismiss   Waive a finding with a reason the human reviewer sees. Security findings cannot be waived.
  files     The files to review and the rules for each, from OCR ${OCR_VERSION} delegation when \`ocr\`
            runs, and from the vendored OCR rules otherwise. PIPELINE_OCR names another ocr binary.
            Install the pinned CLI with \`npm install -g ${OCR_PACKAGE}@${OCR_VERSION}\`.
  save      The reviewers' SubagentStop hook. It saves the reply's findings block beside the package
            the reply names, and blocks the stop until the block matches the schema. A security reply
            that fails twice fails the security gate.

The worktree defaults to .pipeline/work/<slug>/worktrees/<id>, where the build skill creates it.

Exit codes: 0 on success, 1 when the round cannot go on as asked, 2 for bad usage.`;

/**
 * Prints a refusal and returns its exit code
 */
function fail(message: string, code = 2): number {
  console.error(`pipeline review: ${message}`);
  return code;
}

/**
 * Reads the hook payload
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const label = (name: string) => name.padEnd(10);

/**
 * Prints a started round as dispatch lines
 */
function printStarted(started: Started): void {
  const { round } = started;
  const head = `${label("Review")}task ${round.task}, round ${round.round} (${round.scope}), ${round.from.slice(0, 7)}..HEAD`;
  if (started.done) {
    console.log([head, `${label("Done")}${started.done}`].join("\n"));
    return;
  }
  const order = started.dispatch.some((entry) => entry.reviewer === "simplifier") && started.dispatch.length > 1 ? "the simplifier first, and the rest at once when it returns" : "every reviewer at once";
  console.log(
    [
      head,
      `${label("Order")}${order}`,
      ...started.dispatch.map((entry) => `${label("Dispatch")}${entry.agent}${entry.model ? ` on ${entry.model}` : ""} with ${entry.package}`),
      ...(started.dispatch.length === 0 ? [`${label("Merge")}every reviewer replied, so run \`pipeline review merge\``] : []),
      ...round.reviewers.map((reviewer) => `${label("Why")}${reviewer}: ${round.reasons[reviewer]}`),
      ...started.skipped.map((skip) => `${label("Skipped")}${skip.gate}: ${skip.reason}`),
    ].join("\n"),
  );
}

/**
 * Prints a merged round: counts, contests, gates and the fix list, or the verifiers it waits on
 */
function printMerged(outcome: MergeOutcome | Verifying, workOrder: string): void {
  if ("verify" in outcome) {
    console.log(
      [
        `${label("Security")}task ${outcome.round.task} round ${outcome.round.round}: ${outcome.candidates} candidate${outcome.candidates === 1 ? "" : "s"} to verify`,
        ...outcome.verify.map((entry) => `${label("Verify")}${entry.agent} with ${entry.package}`),
        `${label("Then")}merge again once every verdict is saved`,
      ].join("\n"),
    );
    return;
  }
  const { merged, round, gates } = outcome;
  const byAxis = AXES.map((axis) => [axis, merged.accepted.filter((finding) => finding.axis === axis).length] as const).filter(([, count]) => count > 0);
  const byId = new Map(merged.accepted.map((finding) => [finding.id, finding]));
  const lines = [
    `${label("Merged")}task ${round.task} round ${round.round}: ${merged.accepted.length} to fix${byAxis.length > 0 ? ` (${byAxis.map(([axis, count]) => `${axis} ${count}`).join(", ")})` : ""}, ${merged.fixed.length} fixed, ${merged.duplicates.length} duplicate${merged.duplicates.length === 1 ? "" : "s"} dropped, ${merged.backlog.length} to the backlog`,
    ...merged.contests.map(({ high, low }) => {
      const [a, b] = [byId.get(high)!, byId.get(low)!];
      return `${label("Contest")}${a.id} (${a.axis}) and ${b.id} (${b.axis}) both change ${place(b)}. Read both: when they pull opposite ways, run \`pipeline review overrule ${workOrder} --task ${round.task} --finding ${b.id} --over ${a.id}\`, and otherwise leave both on the list.`;
    }),
    ...gates.map((gate) => `${label("Gate")}${gate.gate} ${gate.result}${gate.open > 0 ? `, ${gate.open} open` : ""}`),
    ...(outcome.guide ? [`${label("Guide")}${outcome.guide}`] : []),
    outcome.fixList ? `${label("Fix list")}${outcome.fixList}` : `${label("Done")}no open findings, so review is done for task ${round.task}`,
  ];
  console.log(lines.join("\n"));
}

/**
 * The reviewers' SubagentStop hook
 *
 * The reply names its package, and the package's folder holds the round. A reply that breaks the
 * schema is sent back with the problems, three times at most, so a stuck reviewer still stops.
 */
async function hook(): Promise<number> {
  let input: { last_assistant_message?: string; stop_hook_active?: boolean };
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch {
    input = {};
  }
  const reply = input.last_assistant_message ?? "";
  const line = /^\W*Package:\W*\s*(\/\S+?package-(spec|standards|simplifier|security-(?:hunter|verifier)-\d+)\.md)\W*$/m.exec(reply);
  if (!line) {
    if (!input.stop_hook_active) console.log(JSON.stringify({ decision: "block", reason: "End your reply with the findings as one ```json block, then the line `Package: <path>` from your package." }));
    return 0;
  }
  const [path, name] = [line[1]!, line[2]!];
  const problems = saveReply(reply, path, name, replyJson);
  const blocks = roundPaths(resolve(path, "..")).blocks(name);
  if (problems.length === 0) {
    rmSync(blocks, { force: true });
    return 0;
  }
  const count = (existsSync(blocks) ? Number(readFileSync(blocks, "utf8")) || 0 : 0) + 1;
  writeFileSync(blocks, String(count));
  if (name.startsWith("security-") && count > MAX_SECURITY_BLOCKS) {
    securityReplyFailed(path, name);
    rmSync(blocks, { force: true });
    console.log(JSON.stringify({ systemMessage: `pipeline review: the ${name} reply failed validation twice, so it failed the security gate. Dispatch it again with ${path}.\n${problems.map((problem) => `- ${problem}`).join("\n")}` }));
    return 0;
  }
  if (count > MAX_BLOCKS) {
    console.log(JSON.stringify({ systemMessage: `pipeline review could not save the ${name} findings after ${MAX_BLOCKS} tries:\n${problems.map((problem) => `- ${problem}`).join("\n")}` }));
    return 0;
  }
  console.log(JSON.stringify({ decision: "block", reason: `Your findings block has problems:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n\nReply again with the corrected block and the Package line.` }));
  return 0;
}

/**
 * Parses the verb and runs it
 */
async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        task: { type: "string" },
        worktree: { type: "string" },
        continue: { type: "string" },
        finding: { type: "string" },
        over: { type: "string" },
        reason: { type: "string" },
        from: { type: "string" },
        json: { type: "boolean" },
        hook: { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline review --help".`);
  }
  const { values, positionals } = parsed;
  const [verb, file] = positionals;

  if (verb === "save") return values.hook ? hook() : fail("save runs only as the reviewers' hook, with --hook.");
  if (verb === "files") {
    if (!values.task || !values.from) return fail("files needs --task <worktree> and --from <ref>.");
    const worktree = findTask(resolve(values.task)) ?? resolve(values.task);
    const rules = fileRules(worktree, values.from);
    console.log(values.json ? JSON.stringify(rules, null, 2) : renderFileRules(rules));
    return 0;
  }
  if (!["start", "merge", "overrule", "dismiss"].includes(verb ?? "")) return fail(`give a verb: start, merge, overrule, dismiss, files or save.`);
  if (file === undefined || positionals.length !== 2) return fail("give one work order file after the verb.");
  if (!values.task) return fail("give the task with --task <id>.");

  try {
    const workOrder = resolve(file);
    const ctx = loadContext(workOrder, values.task, values.worktree ? resolve(values.worktree) : undefined);
    if (verb === "start") {
      printStarted(startRound(ctx, values.continue));
      return 0;
    }
    if (verb === "merge") {
      printMerged(mergeTask(ctx), file);
      return 0;
    }
    if (!values.finding) return fail(`${verb} needs --finding <id>.`);
    if (verb === "overrule") {
      if (!values.over) return fail("overrule needs --over <id>, the finding that outranks it.");
      const outcome = overrule(ctx, values.finding, values.over);
      console.log(`pipeline review: overruled ${values.finding} in favor of ${values.over}, and recorded the ruling`);
      if (outcome) printMerged(outcome, file);
      return 0;
    }
    if (!values.reason?.trim()) return fail("dismiss needs --reason with the reason the human reviewer will read.");
    const outcome = dismiss(ctx, values.finding, values.reason);
    console.log(`pipeline review: waived ${values.finding}, and recorded the reason`);
    if (outcome) printMerged(outcome, file);
    return 0;
  } catch (error) {
    if (error instanceof ReviewError) return fail(error.message, error.code);
    throw error;
  }
}

const command: Command = {
  name: "review",
  summary: `Run a task's review rounds: route reviewers, merge findings by precedence, overrule and waive. Reviewers: ${REVIEWERS.join(", ")}.`,
  usage,
  run,
};

export default command;
