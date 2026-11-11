import { type Instance, overlaps, type ReportedFinding, sameProblem, span } from "./findings.ts";

export const HUNTER_AGENT = "dev-pipeline:security-hunter";
export const VERIFIER_AGENT = "dev-pipeline:security-verifier";

export type Depth = "light" | "quick" | "full";

/**
 * How hard a task's security gate looks, read from the gate's name in the tier's gate list
 */
export interface SecurityDepth {
  gate: string;
  depth: Depth;
  hunters: number;
  verifiers: number;
  // The hunter's model on the dispatch line. The verifier's agent file pins Opus.
  model: "sonnet" | "opus";
}

const DEPTHS: Record<Depth, Omit<SecurityDepth, "gate" | "depth">> = {
  light: { hunters: 1, verifiers: 1, model: "sonnet" },
  quick: { hunters: 1, verifiers: 1, model: "sonnet" },
  full: { hunters: 3, verifiers: 3, model: "opus" },
};

/**
 * The security depth a task's gates call for, or null when no gate names security
 */
export function securityPlan(gates: string[]): SecurityDepth | null {
  const gate = gates.find((entry) => /security (?:pass|review)/.test(entry));
  if (gate === undefined) return null;
  const depth: Depth = /\bfull\b/.test(gate) ? "full" : /\bquick\b/.test(gate) ? "quick" : "light";
  return { gate, depth, ...DEPTHS[depth] };
}

// Anchored to demonstrated impact, so a finding cannot claim more than it showed.
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * A vulnerability a hunter reports: the boundary it crosses, what an attacker gets, and the tests that prove the fix
 */
export interface HunterFinding {
  id?: string;
  tag?: "Important" | "Pre-existing";
  file: string;
  line?: number;
  end_line?: number;
  title: string;
  boundary: string;
  result: string;
  severity: Severity;
  detail?: string;
  fix: string;
  tests: string[];
  instances?: Instance[];
}

/**
 * A lead a hunter could not settle, with the one fact that would settle it and no severity
 */
export interface Unresolved {
  file: string;
  line?: number;
  end_line?: number;
  title: string;
  boundary: string;
  fact: string;
}

/**
 * A trust boundary the diff touches, with the invariant it must hold and the tests that prove it
 */
export interface Boundary {
  boundary: string;
  file: string;
  line?: number;
  invariant: string;
  tests: string[];
}

export interface HunterReport {
  findings: HunterFinding[];
  needs_validation: Unresolved[];
  boundaries: Boundary[];
}

/**
 * A hunter finding after merge, with the id the verifiers judge it by
 */
export interface Candidate extends HunterFinding {
  id: string;
}

export type Verdict = "confirmed" | "rejected" | "needs_validation";
const VERDICTS: Verdict[] = ["confirmed", "rejected", "needs_validation"];

export interface VerdictEntry {
  candidate: string;
  verdict: Verdict;
  reason: string;
  fact?: string;
}

/**
 * What one round's security review settled
 */
export interface SecurityOutcome {
  confirmed: Candidate[];
  rejected: (Candidate & { reasons: string[] })[];
  unresolved: (Unresolved & { reason?: string })[];
  boundaries: Boundary[];
}

const isText = (value: unknown, max = Infinity): value is string => typeof value === "string" && value.trim() !== "" && value.length <= max;
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;
const isTests = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((test) => isText(test));

/**
 * Problems with the place an entry names: its file and its line range
 */
function placeProblems(at: string, entry: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (!isText(entry.file)) problems.push(`${at} needs a "file"`);
  if (entry.line !== undefined && !isInt(entry.line)) problems.push(`${at} has a "line" that is not a positive whole number`);
  if (entry.end_line !== undefined && (!isInt(entry.end_line) || !isInt(entry.line) || entry.end_line < entry.line)) problems.push(`${at} has an "end_line" before its "line"`);
  return problems;
}

/**
 * The entries of an optional list, or a problem when the key holds something other than a list
 */
function listOf(value: Record<string, unknown>, key: string, problems: string[]): Record<string, unknown>[] {
  const list = value[key];
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    problems.push(`"${key}" is not a list`);
    return [];
  }
  return list.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) problems.push(`${key} ${index + 1} is not an object`);
    return (entry ?? {}) as Record<string, unknown>;
  });
}

/**
 * Checks a hunter's reply and returns its report or the problems
 *
 * An id must name one of the open security findings, because a hunter re-reports what is still open
 * with its id and leaves out what the fix addressed.
 */
export function validateHunter(value: unknown, openIds: string[]): { report: HunterReport; problems: string[] } {
  const empty: HunterReport = { findings: [], needs_validation: [], boundaries: [] };
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Array.isArray((value as { findings?: unknown }).findings)) {
    return { report: empty, problems: ['the JSON needs a "findings" array, empty when there are none'] };
  }
  const reply = value as Record<string, unknown>;
  const problems: string[] = [];
  listOf(reply, "findings", problems).forEach((entry, index) => {
    const at = `finding ${index + 1}`;
    problems.push(...placeProblems(at, entry));
    if (!isText(entry.title, 200)) problems.push(`${at} needs a "title" of at most 200 characters`);
    if (!isText(entry.boundary)) problems.push(`${at} needs a "boundary", the trust boundary it crosses`);
    if (!isText(entry.result)) problems.push(`${at} needs a "result", what the attacker concretely gets`);
    if (!SEVERITIES.includes(entry.severity as Severity)) problems.push(`${at} has severity "${String(entry.severity)}", not ${SEVERITIES.join(", ")}`);
    if (!isText(entry.fix)) problems.push(`${at} needs a "fix", the smallest change at the last trusted decision point`);
    if (!isTests(entry.tests)) problems.push(`${at} needs "tests", a list naming each test case that proves the fix`);
    if (entry.detail !== undefined && typeof entry.detail !== "string") problems.push(`${at} has a "detail" that is not text`);
    if (entry.tag !== undefined && entry.tag !== "Important" && entry.tag !== "Pre-existing") problems.push(`${at} has tag "${String(entry.tag)}", and a security finding is Important or Pre-existing`);
    if (entry.axis !== undefined && entry.axis !== "security") problems.push(`${at} has axis "${String(entry.axis)}", and the security review reports security`);
    if (entry.id !== undefined && (typeof entry.id !== "string" || !openIds.includes(entry.id))) problems.push(`${at} has id "${String(entry.id)}", which is none of your open findings, so drop the id for a new finding`);
    if (entry.instances !== undefined && (!Array.isArray(entry.instances) || entry.instances.some((instance) => typeof instance?.file !== "string"))) problems.push(`${at} has "instances" that are not a list of {file, line}`);
  });
  listOf(reply, "needs_validation", problems).forEach((entry, index) => {
    const at = `needs_validation ${index + 1}`;
    problems.push(...placeProblems(at, entry));
    if (!isText(entry.title, 200)) problems.push(`${at} needs a "title" of at most 200 characters`);
    if (!isText(entry.boundary)) problems.push(`${at} needs a "boundary"`);
    if (!isText(entry.fact)) problems.push(`${at} needs a "fact", the one unresolved fact that would settle it`);
    if (entry.severity !== undefined) problems.push(`${at} has a severity, and a needs_validation entry carries no severity`);
  });
  listOf(reply, "boundaries", problems).forEach((entry, index) => {
    const at = `boundary ${index + 1}`;
    problems.push(...placeProblems(at, entry));
    if (!isText(entry.boundary)) problems.push(`${at} needs a "boundary"`);
    if (!isText(entry.invariant)) problems.push(`${at} needs an "invariant", what must hold at the boundary`);
    if (!isTests(entry.tests)) problems.push(`${at} needs "tests", a list naming each test case that proves the invariant`);
  });
  if (problems.length > 0) return { report: empty, problems };
  return {
    report: {
      findings: reply.findings as HunterFinding[],
      needs_validation: (reply.needs_validation ?? []) as Unresolved[],
      boundaries: (reply.boundaries ?? []) as Boundary[],
    },
    problems,
  };
}

/**
 * Checks a verifier's reply: one verdict with a reason for each candidate, and a fact for each needs_validation
 */
export function validateVerdicts(value: unknown, ids: string[]): { verdicts: VerdictEntry[]; problems: string[] } {
  const list = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as { verdicts?: unknown }).verdicts : undefined;
  if (!Array.isArray(list)) return { verdicts: [], problems: ['the JSON needs a "verdicts" array with one verdict per candidate'] };
  const problems: string[] = [];
  const seen = new Set<string>();
  list.forEach((raw, index) => {
    const at = `verdict ${index + 1}`;
    const entry = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (!VERDICTS.includes(entry.verdict as Verdict)) problems.push(`${at} has verdict "${String(entry.verdict)}", not ${VERDICTS.join(", ")}`);
    if (!isText(entry.reason)) problems.push(`${at} needs a "reason"`);
    if (entry.verdict === "needs_validation" && !isText(entry.fact)) problems.push(`${at} is needs_validation and needs a "fact", the one unresolved fact that would settle it`);
    if (typeof entry.candidate !== "string" || !ids.includes(entry.candidate)) problems.push(`${at} names candidate "${String(entry.candidate)}", which is not in your package`);
    else if (seen.has(entry.candidate)) problems.push(`${at} judges ${entry.candidate} a second time`);
    else seen.add(entry.candidate);
  });
  for (const id of ids) if (!seen.has(id)) problems.push(`there is no verdict for ${id}`);
  return { verdicts: problems.length === 0 ? (list as VerdictEntry[]) : [], problems };
}

/**
 * The hunters' findings as one candidate list, with duplicates across hunters folded together
 *
 * A finding that keeps an open id keeps that id, and a new one gets the next security id of the
 * round. Nothing in a candidate says which hunter found it, so a verifier cannot defer to one.
 */
export function gatherCandidates(reports: HunterReport[], round: number): { candidates: Candidate[]; unresolved: Unresolved[]; boundaries: Boundary[] } {
  const candidates: Candidate[] = [];
  let next = 1;
  for (const finding of reports.flatMap((report) => report.findings)) {
    const twin = candidates.find((other) => (finding.id !== undefined && other.id === finding.id) || (overlaps(asFinding(other), asFinding(finding)) && sameProblem(other.title, finding.title)));
    if (twin) {
      twin.tests = [...new Set([...twin.tests, ...finding.tests])];
      if (SEVERITIES.indexOf(finding.severity) < SEVERITIES.indexOf(twin.severity)) twin.severity = finding.severity;
      continue;
    }
    candidates.push({ ...finding, tag: finding.tag ?? "Important", id: finding.id ?? `security-${round}.${next++}` });
  }
  const unresolved: Unresolved[] = [];
  for (const entry of reports.flatMap((report) => report.needs_validation)) {
    if (!unresolved.some((other) => other.file === entry.file && sameProblem(other.title, entry.title))) unresolved.push(entry);
  }
  return { candidates, unresolved, boundaries: foldBoundaries(reports.flatMap((report) => report.boundaries)) };
}

/**
 * Boundaries with the same file and the same wording folded into one, their tests joined
 */
function foldBoundaries(list: Boundary[]): Boundary[] {
  const folded: Boundary[] = [];
  for (const entry of list) {
    const twin = folded.find((other) => other.file === entry.file && sameProblem(other.boundary, entry.boundary));
    if (twin) twin.tests = [...new Set([...twin.tests, ...entry.tests])];
    else folded.push({ ...entry, tests: [...entry.tests] });
  }
  return folded;
}

/**
 * The verifiers' verdicts on each candidate, settled by majority
 *
 * A candidate is confirmed or rejected when more than half the verifiers say so. Anything else,
 * a split vote or a majority that could not decide, stays unresolved for the human.
 */
export function tally(candidates: Candidate[], sets: VerdictEntry[][]): Omit<SecurityOutcome, "boundaries"> {
  const outcome: Omit<SecurityOutcome, "boundaries"> = { confirmed: [], rejected: [], unresolved: [] };
  for (const candidate of candidates) {
    const votes = sets.map((set) => set.find((entry) => entry.candidate === candidate.id)).filter((entry): entry is VerdictEntry => entry !== undefined);
    const count = (verdict: Verdict) => votes.filter((entry) => entry.verdict === verdict).length;
    const majority = (verdict: Verdict) => count(verdict) * 2 > sets.length;
    if (majority("confirmed")) {
      outcome.confirmed.push(candidate);
    } else if (majority("rejected")) {
      outcome.rejected.push({ ...candidate, reasons: [...new Set(votes.filter((entry) => entry.verdict === "rejected").map((entry) => entry.reason.trim()))] });
    } else {
      const fact = votes.find((entry) => entry.verdict === "needs_validation")?.fact;
      const split = `the verifiers split ${count("confirmed")} confirmed, ${count("rejected")} rejected and ${count("needs_validation")} unsure`;
      outcome.unresolved.push({ file: candidate.file, line: candidate.line, end_line: candidate.end_line, title: candidate.title, boundary: candidate.boundary, fact: fact ?? split, reason: split });
    }
  }
  return outcome;
}

/**
 * A candidate as a finding the merge and the fix list handle, on the security axis
 */
export function asFinding(candidate: HunterFinding & { id?: string }): ReportedFinding {
  return {
    ...(candidate.id !== undefined ? { id: candidate.id } : {}),
    axis: "security",
    tag: candidate.tag ?? "Important",
    file: candidate.file,
    ...(candidate.line !== undefined ? { line: candidate.line } : {}),
    ...(candidate.end_line !== undefined ? { end_line: candidate.end_line } : {}),
    title: candidate.title,
    detail: candidate.detail?.trim() || candidate.result,
    fix: candidate.fix,
    boundary: candidate.boundary,
    result: candidate.result,
    severity: candidate.severity,
    tests: candidate.tests,
    ...(candidate.instances ? { instances: candidate.instances } : {}),
  };
}

/**
 * A place in the code as `file:line` or `file:start-end`
 */
function at(entry: { file: string; line?: number; end_line?: number }): string {
  const lines = span(entry);
  return lines === null ? `\`${entry.file}\`` : lines[0] === lines[1] ? `\`${entry.file}:${lines[0]}\`` : `\`${entry.file}:${lines[0]}-${lines[1]}\``;
}

const sentence = (text: string) => text.trim().replace(/[.\s]+$/, "");

/**
 * The review guide for the human: the lines to read first, one line per trust boundary with its
 * invariant and tests, what the agents could not settle, and the rejected candidates folded away
 *
 * It reads every round's outcome, so a boundary named in the first round still shows after a fix
 * round that only looked at the fix.
 */
export function renderGuide(outcomes: SecurityOutcome[], open: ReportedFinding[]): string {
  const openIds = new Set(open.map((finding) => finding.id));
  const confirmed = new Map<string, Candidate>();
  for (const outcome of outcomes) for (const candidate of outcome.confirmed) confirmed.set(candidate.id, candidate);
  const fixed = [...confirmed.values()].filter((candidate) => !openIds.has(candidate.id) && candidate.tag !== "Pre-existing");
  const boundaries = foldBoundaries(outcomes.flatMap((outcome) => outcome.boundaries));
  const unresolved: SecurityOutcome["unresolved"] = [];
  for (const entry of outcomes.flatMap((outcome) => outcome.unresolved)) {
    if (!unresolved.some((other) => other.file === entry.file && sameProblem(other.title, entry.title))) unresolved.push(entry);
  }
  const rejected = new Map<string, SecurityOutcome["rejected"][number]>();
  for (const outcome of outcomes) for (const candidate of outcome.rejected) if (!confirmed.has(candidate.id)) rejected.set(candidate.id, candidate);

  const places = new Map<string, Set<string>>();
  for (const entry of [...open, ...unresolved, ...boundaries, ...fixed]) {
    const lines = span(entry);
    const set = places.get(entry.file) ?? new Set<string>();
    if (lines !== null) set.add(lines[0] === lines[1] ? `${lines[0]}` : `${lines[0]}-${lines[1]}`);
    places.set(entry.file, set);
  }
  const read = [...places]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, lines]) => {
      const list = [...lines].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
      return list.length === 0 ? `\`${file}\`` : `\`${file}\` line${list.length > 1 || list[0]!.includes("-") ? "s" : ""} ${list.join(", ")}`;
    });

  const tests = (list: string[]) => list.map(sentence).join(", ");
  const items = [
    ...(read.length > 0 ? [`- Read first: ${read.join(", ")}`] : []),
    ...open.map((finding) => `- Open: ${sentence(finding.title)} at ${at(finding)}${finding.severity ? ` (${finding.severity})` : ""}. Tests: ${tests(finding.tests ?? [])}.`),
    ...boundaries.map((entry) => `- Boundary: ${sentence(entry.boundary)} at ${at(entry)}. Invariant: ${sentence(entry.invariant)}. Tests: ${tests(entry.tests)}.`),
    ...fixed.map((candidate) => `- Fixed: ${sentence(candidate.title)} at ${at(candidate)} (${candidate.severity}). Tests: ${tests(candidate.tests)}.`),
    ...unresolved.map((entry) => `- Unresolved: ${sentence(entry.title)} at ${at(entry)}. Needs: ${sentence(entry.fact)}.`),
  ];
  if (items.length === 0) items.push("- No trust boundary in the diff, and no candidate.");
  const folded =
    rejected.size === 0
      ? []
      : ["", "<details>", `<summary>Rejected candidates (${rejected.size})</summary>`, "", ...[...rejected.values()].map((candidate) => `- ${sentence(candidate.title)} at ${at(candidate)}: ${candidate.reasons.join(" ")}`), "</details>"];
  return `${[...items, ...folded].join("\n")}\n`;
}
