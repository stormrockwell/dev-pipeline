import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { taskSection } from "../commands/brief/section.ts";
import type { Plan, PlannedTask } from "../commands/schedule/plan.ts";
import { appendEntry, complete, gateResults, lastTask, readLedger } from "../ledger/ledger.ts";
import { gitOut } from "../task/git.ts";
import { findTask, readRecord, type TaskRecord } from "../task/record.ts";
import { AGENT_TYPES, type Finding, rank, type ReportedFinding, type Reviewer, validateFindings } from "./findings.ts";
import { mergeRound, place, renderFixList } from "./merge.ts";
import { renderHunterPackage, renderPackage, renderVerifierPackage, reviewGuides } from "./package.ts";
import { diffSize, route } from "./route.ts";
import { readScale } from "./scale.ts";
import { asFinding, type Candidate, gatherCandidates, HUNTER_AGENT, renderGuide, type SecurityOutcome, securityPlan, tally, validateHunter, validateVerdicts, type VerdictEntry, VERIFIER_AGENT } from "./security.ts";
import { guidePath, hunterNames, type Merged, openFindings, readMerged, readRound, type Round, roundDir, roundNumbers, roundPaths, verifierNames, writeRound } from "./state.ts";

// The WordPress attack classes a hunter reads when the diff holds PHP, copied beside the round's packages.
const COMPANION = fileURLToPath(new URL("./wordpress-security.md", import.meta.url));

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
  if (reviewer === "security") return securityPlan(gates)?.gate ?? "security";
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
 *
 * The security gate carries the commit it judged, so a later commit leaves it stale.
 */
function recordGate(ctx: Context, gate: string, result: "pass" | "fail" | "skip", note: string, head?: string): void {
  const latest = gateResults(readLedger(ctx.workOrder), ctx.task.id).get(gate);
  if (latest && latest.result === result && latest.note === note && latest.head === head) return;
  appendEntry(ctx.workOrder, { kind: "gate", at: new Date().toISOString(), task: ctx.task.id, gate, result, note, ...(head ? { head } : {}) });
}

export interface Started {
  round: Round;
  done: string | null;
  // A model is named when the dispatch overrides the agent's own.
  dispatch: { reviewer: Reviewer; agent: string; package: string; model?: string }[];
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
    const clean = merged.accepted.filter((finding) => !removedIds(ctx).includes(finding.id)).length === 0;
    // Security judges one commit, so a commit after a clean round opens a round for it.
    if (clean && (merged.head === ctx.head || securityPlan(ctx.task.gates) === null)) return describe(ctx, readRound(dir), `every gate passed in round ${last}, so review is done for task ${ctx.task.id}`);
    if (!clean && merged.head === ctx.head) throw new ReviewError(`no commits since round ${last} merged, so send the implementer the fix list at ${roundPaths(dir).fixList}.`, 1);
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
  const latestA11y = gateResults(readLedger(ctx.workOrder), ctx.task.id).get("accessibility");
  const accessibilityWaiver = latestA11y?.result === "skip" && latestA11y.note ? latestA11y.note : null;
  const routing = route({ worktree: ctx.record.worktree, base: ctx.record.base, from: previous, original, gates: ctx.task.gates, open, accessibilityWaiver });
  const depth = securityPlan(ctx.task.gates);

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
    security: depth !== null && routing.security !== null ? { ...depth, ...routing.security } : null,
    skipped: [...routing.unbuilt, ...(routing.waived ? [routing.waived] : [])],
    zoneFiles: routing.zoneFiles,
    fixLines: routing.fixLines,
    overruled: [],
    dismissed: [],
  };
  const dir = roundDir(ctx.workOrder, ctx.task.id, number);
  writeRound(dir, round);
  const section = taskSection(readFileSync(ctx.workOrder, "utf8"), ctx.task.id) ?? `## Task ${ctx.task.id}: ${ctx.task.title}`;
  const guides = reviewGuides(ctx.record.worktree, round.from);
  for (const reviewer of round.reviewers) if (reviewer !== "security") writeFileSync(roundPaths(dir).package(reviewer), renderPackage(reviewer, round, ctx.record, section, guides, open, readScale(ctx.record.worktree)));
  if (round.security) {
    if (round.security.php) copyFileSync(COMPANION, roundPaths(dir).companion);
    const mine = open.filter((finding) => finding.reviewer === "security");
    hunterNames(round).forEach((name, index) => writeFileSync(roundPaths(dir).package(name), renderHunterPackage(index + 1, round, ctx.record, section, mine)));
  }
  for (const skip of round.skipped) recordGate(ctx, skip.gate, "skip", skip.reason);
  if (round.reviewers.length === 0) {
    writeMergedRound(ctx, round, { head: ctx.head, accepted: [], backlog: [], duplicates: [], contests: [], fixed: open.map((finding) => finding.id), opened: 0 });
    return describe(ctx, round, `no reviewer this plugin ships applies to task ${ctx.task.id}'s gates, so review is done`);
  }
  return { ...describe(ctx, round, null), changed: routing.changed };
}

/**
 * The dispatch lines of a round for the agents that have not replied, or the reason none are needed
 */
function describe(ctx: Context, round: Round, done: string | null): Started {
  const paths = roundPaths(roundDir(ctx.workOrder, ctx.task.id, round.round));
  const model = round.security?.model === "opus" ? { model: "opus" } : {};
  const all = round.reviewers.flatMap((reviewer): { reviewer: Reviewer; name: string; agent: string; model?: string }[] =>
    reviewer === "security" ? hunterNames(round).map((name) => ({ reviewer, name, agent: HUNTER_AGENT, ...model })) : [{ reviewer, name: reviewer, agent: AGENT_TYPES[reviewer] }],
  );
  return {
    round,
    done,
    dispatch: done ? [] : all.filter((entry) => !existsSync(paths.findings(entry.name))).map(({ name, ...entry }) => ({ ...entry, package: paths.package(name) })),
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
function readReport(ctx: Context, dir: string, round: number, reviewer: Exclude<Reviewer, "security">): ReportedFinding[] {
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
  guide: string | null;
}

/**
 * A round that stopped so the verifiers can judge the hunters' candidates
 */
export interface Verifying {
  round: Round;
  verify: { agent: string; package: string }[];
  candidates: number;
}

/**
 * Fails a round's security gate at HEAD with the reason, so a missing or broken reply never passes it
 */
function failSecurity(ctx: Context, round: Round, why: string): void {
  if (round.security) recordGate(ctx, round.security.gate, "fail", `round ${round.round}, ${why}`, ctx.head);
}

/**
 * Merges the current round's findings, writes the fix list, and records the round and each reviewer's gate
 *
 * Security takes two steps. With every hunter in and candidates to judge, merge writes the
 * verifiers' packages and stops. With the verdicts in, the confirmed candidates join the other
 * findings, and the rest go to the review guide.
 */
export function mergeTask(ctx: Context): MergeOutcome | Verifying {
  const { dir, round } = currentRound(ctx);
  const paths = roundPaths(dir);
  const others = round.reviewers.filter((reviewer): reviewer is Exclude<Reviewer, "security"> => reviewer !== "security");
  const missing = [...others.map((reviewer) => ({ name: reviewer as string, agent: AGENT_TYPES[reviewer] })), ...hunterNames(round).map((name) => ({ name, agent: HUNTER_AGENT }))].filter((entry) => !existsSync(paths.findings(entry.name)));
  if (missing.length > 0) {
    const hunters = missing.filter((entry) => entry.agent === HUNTER_AGENT).map((entry) => entry.name);
    if (hunters.length > 0) failSecurity(ctx, round, `no reply from ${hunters.join(", ")}`);
    const reviewers = missing.filter((entry) => entry.agent !== HUNTER_AGENT).map((entry) => paths.findings(entry.name));
    const write = reviewers.length > 0 ? `, or write a reviewer's reply findings block to ${reviewers.join(", ")}` : "";
    const security = hunters.length > 0 ? " A security reply is never written by hand, so dispatch the hunter again. The security gate stays failed until its reply saves." : "";
    throw new ReviewError(`no findings yet from ${missing.map((entry) => entry.name).join(", ")}. Dispatch ${missing.map((entry) => `${entry.agent} with ${paths.package(entry.name)}`).join(", ")}${write}.${security}`, 1);
  }
  const reports = new Map<Reviewer, ReportedFinding[]>(others.map((reviewer) => [reviewer, readReport(ctx, dir, round.round, reviewer)] as const));
  if (round.security) {
    const settled = settleSecurity(ctx, dir, round);
    if ("verify" in settled) return settled;
    writeFileSync(paths.security, `${JSON.stringify(settled, null, 2)}\n`);
    reports.set("security", settled.confirmed.map(asFinding));
  }
  const open = openFindings(ctx.workOrder, ctx.task.id, round.round);
  const removed = removedIds(ctx);
  const merged = mergeRound({ round: round.round, scope: round.scope, head: ctx.head, reports, open, removed, fixLines: round.fixLines });
  return writeMergedRound(ctx, round, merged);
}

/**
 * The hunters' candidates gathered once per round, with their ids fixed for the verifiers
 */
function roundCandidates(ctx: Context, dir: string, round: Round): ReturnType<typeof gatherCandidates> {
  const paths = roundPaths(dir);
  if (existsSync(paths.candidates)) return JSON.parse(readFileSync(paths.candidates, "utf8")) as ReturnType<typeof gatherCandidates>;
  const openIds = stillOpen(ctx, round.round).filter((finding) => finding.reviewer === "security").map((finding) => finding.id);
  const reports = hunterNames(round).map((name) => {
    const path = paths.findings(name);
    const { report, problems } = validateHunter(JSON.parse(readFileSync(path, "utf8")), openIds);
    if (problems.length > 0) {
      failSecurity(ctx, round, `${name}'s findings break the schema`);
      throw new ReviewError(`${path} does not match the security findings schema:\n${problems.map((problem) => `- ${problem}`).join("\n")}`, 1);
    }
    return report;
  });
  const gathered = gatherCandidates(reports, round.round);
  writeFileSync(paths.candidates, `${JSON.stringify(gathered, null, 2)}\n`);
  return gathered;
}

/**
 * The round's security outcome, or the verifier dispatches it waits on
 */
function settleSecurity(ctx: Context, dir: string, round: Round): SecurityOutcome | Verifying {
  const paths = roundPaths(dir);
  const { candidates, unresolved, boundaries } = roundCandidates(ctx, dir, round);
  if (candidates.length === 0) return { confirmed: [], rejected: [], unresolved, boundaries };
  const names = verifierNames(round);
  const waiting = names.filter((name) => !existsSync(paths.findings(name)));
  if (waiting.length > 0) {
    const section = taskSection(readFileSync(ctx.workOrder, "utf8"), ctx.task.id) ?? `## Task ${ctx.task.id}: ${ctx.task.title}`;
    names.forEach((name, index) => {
      if (!existsSync(paths.package(name))) writeFileSync(paths.package(name), renderVerifierPackage(index + 1, round, ctx.record, section, candidates));
    });
    failSecurity(ctx, round, `waiting on ${waiting.length} verifier verdict${waiting.length === 1 ? "" : "s"}`);
    return { round, verify: waiting.map((name) => ({ agent: VERIFIER_AGENT, package: paths.package(name) })), candidates: candidates.length };
  }
  const ids = candidates.map((candidate) => candidate.id);
  const sets = names.map((name) => {
    const path = paths.findings(name);
    const { verdicts, problems } = validateVerdicts(JSON.parse(readFileSync(path, "utf8")), ids);
    if (problems.length > 0) {
      failSecurity(ctx, round, `${name}'s verdicts break the schema`);
      throw new ReviewError(`${path} does not match the verdicts schema:\n${problems.map((problem) => `- ${problem}`).join("\n")}`, 1);
    }
    return verdicts as VerdictEntry[];
  });
  const settled = tally(candidates as Candidate[], sets);
  return { ...settled, unresolved: [...unresolved, ...settled.unresolved], boundaries };
}

/**
 * Writes a merged round, its fix list and backlog, and records the round and its gates
 */
function writeMergedRound(ctx: Context, round: Round, merged: Merged): MergeOutcome {
  const dir = roundDir(ctx.workOrder, ctx.task.id, round.round);
  const paths = roundPaths(dir);
  writeFileSync(paths.merged, `${JSON.stringify(merged, null, 2)}\n`);
  const fixList = merged.accepted.length > 0 ? renderFixList(merged, ctx.task.id, round.round, ctx.record.worktree, ctx.record.tdd.required) : null;
  if (fixList) writeFileSync(paths.fixList, fixList);

  const backlogPath = join(dirname(ctx.workOrder), "backlog.jsonl");
  const known = existsSync(backlogPath) ? readFileSync(backlogPath, "utf8") : "";
  for (const entry of merged.backlog) if (!known.includes(`"id":"${entry.id}"`)) appendFileSync(backlogPath, `${JSON.stringify({ task: ctx.task.id, ...entry })}\n`);

  appendEntry(ctx.workOrder, { kind: "round", at: new Date().toISOString(), task: ctx.task.id, round: round.round, scope: round.scope, head: merged.head, opened: merged.opened, fixed: merged.fixed.length });
  const gates = round.reviewers.map((reviewer) => {
    const count = merged.accepted.filter((finding) => finding.reviewer === reviewer).length;
    const gate = reviewerGate(reviewer, ctx.task.gates);
    const result = count === 0 ? ("pass" as const) : ("fail" as const);
    recordGate(ctx, gate, result, count === 0 ? `round ${round.round}, no open findings` : `round ${round.round}, ${count} open`, reviewer === "security" ? merged.head : undefined);
    return { gate, result, open: count };
  });
  let guide: string | null = null;
  if (round.security) {
    guide = guidePath(ctx.workOrder, ctx.task.id);
    const outcomes = roundNumbers(ctx.workOrder, ctx.task.id)
      .filter((number) => number <= round.round)
      .map((number) => roundPaths(roundDir(ctx.workOrder, ctx.task.id, number)).security)
      .filter((path) => existsSync(path))
      .map((path) => JSON.parse(readFileSync(path, "utf8")) as SecurityOutcome);
    writeFileSync(guide, renderGuide(outcomes, merged.accepted.filter((finding) => finding.reviewer === "security")));
  }
  return { round, merged, gates, fixList: fixList ? paths.fixList : null, guide };
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
 * accepts it on the PR or the work goes back to planning. The lower finding of a contest goes
 * through overrule, so precedence always leaves a ruling.
 */
export function dismiss(ctx: Context, id: string, reason: string): MergeOutcome | null {
  const finding = findAccepted(ctx, id);
  if (finding.axis === "security") throw new ReviewError(`${id} is a security finding, which only a peer reviewer can accept on the PR.`, 1);
  const { dir, round } = currentRoundOrLast(ctx);
  const contest = readMerged(dir)?.contests.find((entry) => entry.low === id);
  if (contest) {
    throw new ReviewError(`${id} is in a contest with ${contest.high}, which outranks it on the same lines. When they pull opposite ways, overrule it, so the ruling is recorded. When they do not, leave both on the list.`, 1);
  }
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
  if (merged === null || merged.head !== ctx.head) return null;
  const outcome = mergeTask(ctx);
  return "verify" in outcome ? null : outcome;
}

/**
 * A context for a round reached through its package, as the Stop hook knows it
 */
function packageContext(round: Round): Context {
  const record = readRecord(round.worktree);
  return { workOrder: record.workOrder, task: { id: round.task, gates: [] as string[] } as PlannedTask, record, head: gitOut(round.worktree, ["rev-parse", "HEAD"]) };
}

/**
 * Saves a reply as the round's findings or verdicts, or returns the problems that block its stop
 *
 * The name is a reviewer, or a security hunter or verifier with its number.
 */
export function saveReply(reply: string, packagePath: string, name: string, parse: (reply: string) => { value: unknown } | { error: string }): string[] {
  const dir = dirname(packagePath);
  const paths = roundPaths(dir);
  if (!existsSync(paths.state)) return [`${packagePath} is not a review package from \`pipeline review start\``];
  const round = readRound(dir);
  const security = name.startsWith("security-");
  const asked = security ? [...hunterNames(round), ...(existsSync(paths.candidates) ? verifierNames(round) : [])] : round.reviewers;
  if (!asked.includes(name)) return [`round ${round.round} of task ${round.task} did not ask ${name} to review`];
  writeFileSync(paths.reply(name), `${reply.trim()}\n`);
  const parsed = parse(reply);
  if ("error" in parsed) return [parsed.error];
  const ctx = packageContext(round);
  const openIds = (reviewer: Reviewer) => stillOpen(ctx, round.round).filter((finding) => finding.reviewer === reviewer).map((finding) => finding.id);
  let problems: string[];
  if (name.startsWith("security-hunter-")) problems = validateHunter(parsed.value, openIds("security")).problems;
  else if (name.startsWith("security-verifier-")) {
    const { candidates } = JSON.parse(readFileSync(paths.candidates, "utf8")) as { candidates: Candidate[] };
    problems = validateVerdicts(parsed.value, candidates.map((candidate) => candidate.id)).problems;
  } else problems = validateFindings(name as Reviewer, parsed.value, openIds(name as Reviewer)).problems;
  if (problems.length > 0) return problems;
  writeFileSync(paths.findings(name), `${JSON.stringify(parsed.value, null, 2)}\n`);
  return [];
}

/**
 * Fails the security gate of the round a package belongs to, for a reply that never validated
 */
export function securityReplyFailed(packagePath: string, name: string): void {
  const dir = dirname(packagePath);
  if (!existsSync(roundPaths(dir).state)) return;
  const round = readRound(dir);
  failSecurity(packageContext(round), round, `${name}'s reply failed validation twice`);
}
