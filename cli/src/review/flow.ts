import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { taskSection } from "../commands/brief/section.ts";
import type { Plan, PlannedTask } from "../commands/schedule/plan.ts";
import { appendEntry, complete, gateResults, lastTask, readLedger } from "../ledger/ledger.ts";
import { gitOut } from "../task/git.ts";
import { findTask, readRecord, type TaskRecord } from "../task/record.ts";
import { AGENT_TYPES, type Finding, rank, type ReportedFinding, type Reviewer, validateFindings } from "./findings.ts";
import { mergeRound, place, renderFixList } from "./merge.ts";
import { renderPackage, reviewGuides } from "./package.ts";
import { diffSize, route } from "./route.ts";
import { type Merged, openFindings, readMerged, readRound, type Round, roundDir, roundNumbers, roundPaths, writeRound } from "./state.ts";

// Rounds before the orchestrator stops and asks whether the approach needs rethinking.
export const MAX_ROUNDS = 3;

/**
 * A refusal with the exit code the command returns for it
 */
export class ReviewError extends Error {
  readonly code: number;

  /**
   * Builds the refusal
   */
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

/**
 * Everything a review command needs about one task
 */
export interface Context {
  workOrder: string;
  task: PlannedTask;
  record: TaskRecord;
  head: string;
}

/**
 * Loads a task's plan entry and its briefed worktree, which defaults to the build skill's path
 */
export function loadContext(workOrder: string, taskId: string, worktree: string | undefined): Context {
  if (!existsSync(workOrder)) throw new ReviewError(`no work order at ${workOrder}.`, 2);
  const planFile = join(dirname(workOrder), "plan.json");
  if (!existsSync(planFile)) throw new ReviewError("no plan.json beside the work order, so run `pipeline schedule` first.", 2);
  const task = (JSON.parse(readFileSync(planFile, "utf8")) as Plan).tasks.find((entry) => entry.id === taskId);
  if (!task) throw new ReviewError(`the plan has no task ${taskId}.`, 2);
  const where = worktree ?? join(dirname(workOrder), "worktrees", taskId);
  const top = findTask(where);
  if (top === null) throw new ReviewError(`no briefed task in ${where}, so give its worktree with --worktree.`, 2);
  const record = readRecord(top);
  if (record.id !== taskId || record.workOrder !== workOrder) throw new ReviewError(`${top} holds task ${record.id} of ${record.workOrder}, not task ${taskId}.`, 2);
  return { workOrder, task, record, head: gitOut(top, ["rev-parse", "HEAD"]) };
}

/**
 * The gate a reviewer's result goes under, by the name the tier's gate list uses
 */
export function reviewerGate(reviewer: Reviewer, gates: string[]): string {
  if (reviewer === "simplifier") return gates.find((gate) => gate.startsWith("simplifier")) ?? "simplifier";
  return reviewer;
}

/**
 * Finding ids taken out by an overrule or a dismissal in any round
 */
function removedIds(ctx: Context): string[] {
  return roundNumbers(ctx.workOrder, ctx.task.id).flatMap((number) => {
    const round = readRound(roundDir(ctx.workOrder, ctx.task.id, number));
    return [...round.overruled.map((entry) => entry.finding), ...round.dismissed];
  });
}

/**
 * The open findings a round's reviewers check, less any taken off since
 */
function stillOpen(ctx: Context, before = Infinity): Finding[] {
  const removed = removedIds(ctx);
  return openFindings(ctx.workOrder, ctx.task.id, before).filter((finding) => !removed.includes(finding.id));
}

/**
 * Records a gate result unless the gate's latest result already says the same
 */
function recordGate(ctx: Context, gate: string, result: "pass" | "fail" | "skip", note: string): void {
  const latest = gateResults(readLedger(ctx.workOrder), ctx.task.id).get(gate);
  if (latest && latest.result === result && latest.note === note) return;
  appendEntry(ctx.workOrder, { kind: "gate", at: new Date().toISOString(), task: ctx.task.id, gate, result, note });
}

export interface Started {
  round: Round;
  done: string | null;
  dispatch: { reviewer: Reviewer; agent: string; package: string }[];
  skipped: { gate: string; reason: string }[];
  changed: number;
}

/**
 * Opens the next review round, or reprints the open one
 *
 * Review starts from a commit task-check passed, so the fix pass must reach green and pass its
 * check before the next round. A round past the third needs the developer's reason, which goes
 * into the ledger as a ruling.
 */
export function startRound(ctx: Context, continueReason: string | undefined): Started {
  const settled = lastTask(readLedger(ctx.workOrder), ctx.task.id);
  if (!complete(settled) || settled!.head !== ctx.head) {
    throw new ReviewError(`task ${ctx.task.id} has no passing check at HEAD, so run \`pipeline task-check --task ${ctx.record.worktree}\` first. Review starts from the commit it records.`, 1);
  }
  const numbers = roundNumbers(ctx.workOrder, ctx.task.id);
  const last = numbers.at(-1);
  if (last !== undefined) {
    const dir = roundDir(ctx.workOrder, ctx.task.id, last);
    const merged = readMerged(dir);
    if (merged === null) return describe(ctx, readRound(dir), null);
    if (merged.accepted.filter((finding) => !removedIds(ctx).includes(finding.id)).length === 0) return describe(ctx, readRound(dir), `every gate passed in round ${last}, so review is done for task ${ctx.task.id}`);
    if (merged.head === ctx.head) throw new ReviewError(`no commits since round ${last} merged, so send the implementer the fix list at ${roundPaths(dir).fixList}.`, 1);
  }
  const number = (last ?? 0) + 1;
  if (number > MAX_ROUNDS) {
    if (!continueReason?.trim()) {
      throw new ReviewError(`task ${ctx.task.id} has had ${MAX_ROUNDS} review rounds. Stop and ask the developer whether the approach needs rethinking, then rerun with --continue "<their reason>" only if they say go on.`, 1);
    }
    appendEntry(ctx.workOrder, { kind: "ruling", at: new Date().toISOString(), task: ctx.task.id, decided: `Ran review round ${number} past the ${MAX_ROUNDS}-round cap`, why: continueReason.trim().replace(/\.+$/, ""), cost: "another round of review and fixes" });
  }

  const open = stillOpen(ctx);
  const firstHead = number === 1 ? null : readMerged(roundDir(ctx.workOrder, ctx.task.id, 1))?.head ?? null;
  const original = firstHead === null ? null : diffSize(ctx.record.worktree, ctx.record.base, firstHead);
  const previous = last === undefined ? null : readMerged(roundDir(ctx.workOrder, ctx.task.id, last))!.head;
  const routing = route({ worktree: ctx.record.worktree, base: ctx.record.base, from: previous, original, gates: ctx.task.gates, open });

  const round: Round = {
    task: ctx.task.id,
    round: number,
    scope: routing.scope,
    worktree: ctx.record.worktree,
    base: ctx.record.base,
    from: routing.scope === "full" ? ctx.record.base : previous!,
    startHead: ctx.head,
    reviewers: routing.reviewers,
    reasons: routing.reasons,
    skipped: [
      ...ctx.task.gates.filter((gate) => /security (?:pass|review)/.test(gate)).map((gate) => ({ gate, reason: "the security reviewer ships in 3.1" })),
      ...ctx.task.gates.filter((gate) => gate === "axe").map((gate) => ({ gate, reason: "the accessibility check ships in 3.6" })),
      ...routing.unbuilt.filter((entry) => !(entry.gate === "accessibility" && ctx.task.gates.includes("axe"))),
    ],
    zoneFiles: routing.zoneFiles,
    fixLines: routing.fixLines,
    overruled: [],
    dismissed: [],
  };
  const dir = roundDir(ctx.workOrder, ctx.task.id, number);
  writeRound(dir, round);
  const section = taskSection(readFileSync(ctx.workOrder, "utf8"), ctx.task.id) ?? `## Task ${ctx.task.id}: ${ctx.task.title}`;
  const guides = reviewGuides(ctx.record.worktree, round.from);
  for (const reviewer of round.reviewers) writeFileSync(roundPaths(dir).package(reviewer), renderPackage(reviewer, round, ctx.record, section, guides, open));
  for (const skip of round.skipped) recordGate(ctx, skip.gate, "skip", skip.reason);
  if (round.reviewers.length === 0) {
    writeMergedRound(ctx, round, { head: ctx.head, accepted: [], backlog: [], duplicates: [], contests: [], fixed: open.map((finding) => finding.id), opened: 0 });
    return describe(ctx, round, `no reviewer this plugin ships applies to task ${ctx.task.id}'s gates, so review is done`);
  }
  return { ...describe(ctx, round, null), changed: routing.changed };
}

/**
 * The dispatch lines of a round, or the reason none are needed
 */
function describe(ctx: Context, round: Round, done: string | null): Started {
  const paths = roundPaths(roundDir(ctx.workOrder, ctx.task.id, round.round));
  return {
    round,
    done,
    dispatch: done ? [] : round.reviewers.map((reviewer) => ({ reviewer, agent: AGENT_TYPES[reviewer], package: paths.package(reviewer) })),
    skipped: round.skipped,
    changed: 0,
  };
}

/**
 * The round merge works on: the open one, or the last merged one while HEAD has not moved past it
 */
function currentRound(ctx: Context): { dir: string; round: Round } {
  const last = roundNumbers(ctx.workOrder, ctx.task.id).at(-1);
  if (last === undefined) throw new ReviewError(`task ${ctx.task.id} has no review round, so run \`pipeline review start\` first.`, 1);
  const dir = roundDir(ctx.workOrder, ctx.task.id, last);
  const merged = readMerged(dir);
  if (merged !== null && merged.head !== ctx.head) throw new ReviewError(`round ${last} merged at ${merged.head.slice(0, 7)} and HEAD has moved, so run \`pipeline review start\` for the next round.`, 1);
  return { dir, round: readRound(dir) };
}

/**
 * Reads and checks one reviewer's saved findings
 */
function readReport(ctx: Context, dir: string, round: number, reviewer: Reviewer): ReportedFinding[] {
  const path = roundPaths(dir).findings(reviewer);
  const openIds = stillOpen(ctx, round).filter((finding) => finding.reviewer === reviewer).map((finding) => finding.id);
  const { findings, problems } = validateFindings(reviewer, JSON.parse(readFileSync(path, "utf8")), openIds);
  if (problems.length > 0) throw new ReviewError(`${path} does not match the findings schema:\n${problems.map((problem) => `- ${problem}`).join("\n")}`, 1);
  return findings;
}

export interface MergeOutcome {
  round: Round;
  merged: Merged;
  gates: { gate: string; result: "pass" | "fail"; open: number }[];
  fixList: string | null;
}

/**
 * Merges the current round's findings, writes the fix list, and records the round and each reviewer's gate
 */
export function mergeTask(ctx: Context): MergeOutcome {
  const { dir, round } = currentRound(ctx);
  const missing = round.reviewers.filter((reviewer) => !existsSync(roundPaths(dir).findings(reviewer)));
  if (missing.length > 0) {
    throw new ReviewError(`no findings yet from ${missing.join(", ")}. Dispatch ${missing.map((reviewer) => AGENT_TYPES[reviewer]).join(", ")} with ${missing.map((reviewer) => roundPaths(dir).package(reviewer)).join(", ")}, or write its reply's findings block to ${missing.map((reviewer) => roundPaths(dir).findings(reviewer)).join(", ")}.`, 1);
  }
  const reports = new Map(round.reviewers.map((reviewer) => [reviewer, readReport(ctx, dir, round.round, reviewer)] as const));
  const open = openFindings(ctx.workOrder, ctx.task.id, round.round);
  const removed = removedIds(ctx);
  const merged = mergeRound({ round: round.round, scope: round.scope, head: ctx.head, reports, open, removed, fixLines: round.fixLines });
  return writeMergedRound(ctx, round, merged);
}

/**
 * Writes a merged round, its fix list and backlog, and records the round and its gates
 */
function writeMergedRound(ctx: Context, round: Round, merged: Merged): MergeOutcome {
  const dir = roundDir(ctx.workOrder, ctx.task.id, round.round);
  const paths = roundPaths(dir);
  writeFileSync(paths.merged, `${JSON.stringify(merged, null, 2)}\n`);
  const fixList = merged.accepted.length > 0 ? renderFixList(merged, ctx.task.id, round.round, ctx.record.worktree) : null;
  if (fixList) writeFileSync(paths.fixList, fixList);

  const backlogPath = join(dirname(ctx.workOrder), "backlog.jsonl");
  const known = existsSync(backlogPath) ? readFileSync(backlogPath, "utf8") : "";
  for (const entry of merged.backlog) if (!known.includes(`"id":"${entry.id}"`)) appendFileSync(backlogPath, `${JSON.stringify({ task: ctx.task.id, ...entry })}\n`);

  appendEntry(ctx.workOrder, { kind: "round", at: new Date().toISOString(), task: ctx.task.id, round: round.round, scope: round.scope, head: merged.head, opened: merged.opened, fixed: merged.fixed.length });
  const gates = round.reviewers.map((reviewer) => {
    const count = merged.accepted.filter((finding) => finding.reviewer === reviewer).length;
    const gate = reviewerGate(reviewer, ctx.task.gates);
    const result = count === 0 ? ("pass" as const) : ("fail" as const);
    recordGate(ctx, gate, result, count === 0 ? `round ${round.round}, no open findings` : `round ${round.round}, ${count} open`);
    return { gate, result, open: count };
  });
  return { round, merged, gates, fixList: fixList ? paths.fixList : null };
}

/**
 * A finding on the last round's fix list
 */
function findAccepted(ctx: Context, id: string): Finding {
  const { dir } = currentRoundOrLast(ctx);
  const finding = readMerged(dir)?.accepted.find((entry) => entry.id === id);
  if (!finding) throw new ReviewError(`${id} is not on the last round's fix list.`, 2);
  return finding;
}

/**
 * The task's last round, merged or not
 */
function currentRoundOrLast(ctx: Context): { dir: string; round: Round } {
  const last = roundNumbers(ctx.workOrder, ctx.task.id).at(-1);
  if (last === undefined) throw new ReviewError(`task ${ctx.task.id} has no review round.`, 1);
  const dir = roundDir(ctx.workOrder, ctx.task.id, last);
  return { dir, round: readRound(dir) };
}

/**
 * Takes the lower finding of a contest off the fix list, and records the ruling and the waiver
 *
 * Only precedence can overrule, so the winner must sit on a higher axis than the loser.
 */
export function overrule(ctx: Context, loserId: string, winnerId: string): MergeOutcome | null {
  const [loser, winner] = [findAccepted(ctx, loserId), findAccepted(ctx, winnerId)];
  if (rank(winner.axis) >= rank(loser.axis)) {
    throw new ReviewError(`${winner.id} is ${winner.axis} and ${loser.id} is ${loser.axis}, so precedence does not settle it. Dismiss one with a reason, or fix both.`, 1);
  }
  const { dir, round } = currentRoundOrLast(ctx);
  if (!round.overruled.some((entry) => entry.finding === loser.id)) round.overruled.push({ finding: loser.id, over: winner.id });
  writeRound(dir, round);
  const at = new Date().toISOString();
  appendEntry(ctx.workOrder, {
    kind: "ruling",
    at,
    task: ctx.task.id,
    decided: `Overruled ${loser.id} (${loser.axis}, ${loser.title.replace(/\.+$/, "")}) in favor of ${winner.id} (${winner.axis}) at ${place(loser)}`,
    why: `${winner.axis} outranks ${loser.axis}, and the two pull the same lines in opposite directions`,
    cost: `the ${loser.axis} change waits for a later PR`,
  });
  appendEntry(ctx.workOrder, { kind: "accepted", at, task: ctx.task.id, gate: reviewerGate(loser.reviewer, ctx.task.gates), finding: `${loser.id}: ${loser.title.replace(/\.+$/, "")}`, reason: `overruled by ${winner.id}, because ${winner.axis} outranks ${loser.axis}` });
  return remerge(ctx);
}

/**
 * Waives a finding with a reason the human reviewer sees, so it leaves the fix list
 *
 * A security finding is never waived here, because the cap on rounds never parks one: a peer
 * accepts it on the PR or the work goes back to planning.
 */
export function dismiss(ctx: Context, id: string, reason: string): MergeOutcome | null {
  const finding = findAccepted(ctx, id);
  if (finding.axis === "security") throw new ReviewError(`${id} is a security finding, which only a peer reviewer can accept on the PR.`, 1);
  const { dir, round } = currentRoundOrLast(ctx);
  if (!round.dismissed.includes(id)) round.dismissed.push(id);
  writeRound(dir, round);
  appendEntry(ctx.workOrder, { kind: "accepted", at: new Date().toISOString(), task: ctx.task.id, gate: reviewerGate(finding.reviewer, ctx.task.gates), finding: `${id}: ${finding.title.replace(/\.+$/, "")}`, reason: reason.trim().replace(/\.+$/, "") });
  return remerge(ctx);
}

/**
 * Merges again when HEAD still sits where the round merged, so the fix list drops what was taken off
 */
function remerge(ctx: Context): MergeOutcome | null {
  const { dir } = currentRoundOrLast(ctx);
  const merged = readMerged(dir);
  return merged !== null && merged.head === ctx.head ? mergeTask(ctx) : null;
}

/**
 * Saves a reviewer's reply as the round's findings, or returns the problems that block its stop
 */
export function saveReply(reply: string, packagePath: string, reviewer: Reviewer, parse: (reply: string) => { value: unknown } | { error: string }): string[] {
  const dir = dirname(packagePath);
  const paths = roundPaths(dir);
  if (!existsSync(paths.state)) return [`${packagePath} is not a review package from \`pipeline review start\``];
  const round = readRound(dir);
  if (!round.reviewers.includes(reviewer)) return [`round ${round.round} of task ${round.task} did not ask ${reviewer} to review`];
  writeFileSync(paths.reply(reviewer), `${reply.trim()}\n`);
  const parsed = parse(reply);
  if ("error" in parsed) return [parsed.error];
  const record = readRecord(round.worktree);
  const ctx: Context = { workOrder: record.workOrder, task: { id: round.task } as PlannedTask, record, head: "" };
  const openIds = stillOpen(ctx, round.round).filter((finding) => finding.reviewer === reviewer).map((finding) => finding.id);
  const { problems } = validateFindings(reviewer, parsed.value, openIds);
  if (problems.length > 0) return problems;
  writeFileSync(paths.findings(reviewer), `${JSON.stringify(parsed.value, null, 2)}\n`);
  return [];
}
