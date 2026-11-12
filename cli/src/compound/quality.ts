import { createHash } from "node:crypto";
import { type Axis, REVIEWER_AXES, REVIEWERS, type Reviewer } from "../review/findings.ts";
import { vendoredRule } from "../review/rules.ts";
import type { MergedPr, RepoData, Touch } from "./github.ts";

/**
 * How one signal says a PR let something through
 *
 * `human` is a reviewer's comment, `fix` a later `fix:` commit on the PR's files, `revert` a commit
 * that reverted it, and `skip` a gate the PR skipped before a fix landed on it.
 */
export type SignalKind = "human" | "fix" | "revert" | "skip";

// A person's catch outranks an inferred one, and a skip only adds weight to a fix already counted.
const WEIGHTS: Record<SignalKind, number> = { human: 3, revert: 3, fix: 2, skip: 1 };

/**
 * A kind of miss, keyed by the axis that should have caught it and the area of code it sits in
 *
 * The fingerprint hashes only the axis and area, so the same class from any repo or developer
 * shares it, and it names no repo.
 */
export interface MissedClass {
  fingerprint: string;
  axis: Axis;
  area: string;
  // The reviewer that owns the axis, so the stage that should have caught the miss.
  owner: Reviewer;
  score: number;
  prs: number;
  repos: number;
  signals: Record<SignalKind, number>;
  hints: string[];
  examples: { repo: string; pr: number; kind: SignalKind; text: string; path: string | null }[];
  // Every PR behind the class as `owner/name#number`, kept local so a later filing can tell new evidence from old.
  refs: string[];
}

/**
 * What slipped through, as the compounder's quality half reads it
 */
export interface QualityReport {
  sources: { repos: { repo: string; prs: number; records: number; fetchedAt: string }[]; prs: number; records: number; from: string | null; to: string | null; windowDays: number };
  comments: { human: number; agent: number; author: number; reviewers: number; prs: number };
  fixes: { commits: number; prs: number };
  reverts: { commits: number; prs: number };
  // Of the PRs that carry a gate record: how many skipped a gate, and how many on each side later needed a fix.
  skips: { recorded: number; skipped: number; skippedThenFixed: number; cleanThenFixed: number; gates: { gate: string; skipped: number; laterFixed: number }[] };
  classes: MissedClass[];
}

export interface QualityOptions {
  windowDays: number;
  top: number;
}

interface Signal {
  kind: SignalKind;
  repo: string;
  pr: MergedPr;
  axis: Axis;
  touches: Touch[];
  text: string;
  path: string | null;
}

const DAY = 24 * 60 * 60 * 1000;
// Files a fix touches as bookkeeping, which say nothing about where the defect was.
const BOOKKEEPING = /(^|\/)(package-lock\.json|composer\.lock|yarn\.lock|pnpm-lock\.yaml|CHANGELOG(\.md)?|readme\.txt)$/i;

// Highest axis first, so a comment naming a hole and a typo counts as security.
const KEYWORDS: [Axis, RegExp][] = [
  ["security", /\b(secur\w*|vuln\w*|xss|csrf|nonce|sanitiz\w*|escap\w*|inject\w*|sqli?|auth\w*|permission\w*|capabilit\w*|secret\w*|password\w*|credential\w*|unserializ\w*|open redirect|idor|cve)\b/i],
  ["performance", /\b(perf\w*|slow\w*|latency|n\+1|quer(y|ies) (per|in a loop|count)|cach\w*|memory|paginat\w*)\b/i],
  ["readability", /\b(readab\w*|simplif\w*|confus\w*|unclear|duplicat\w*|dead code|unused|too complex|refactor\w*|clean ?up)\b/i],
  ["style", /\b(nam(e|ing)|renam\w*|typo\w*|format\w*|indent\w*|whitespace|lint\w*|style|convention\w*|spelling|wording)\b/i],
];

/**
 * The axis a piece of text names, or correctness when it names none, since a fix corrects behaviour
 */
export function axisOf(text: string): Axis {
  return KEYWORDS.find(([, pattern]) => pattern.test(text))?.[0] ?? "correctness";
}

/**
 * The axis whose reviewer runs a gate
 */
function gateAxis(gate: string): Axis {
  if (/security/i.test(gate)) return "security";
  if (/performance/i.test(gate)) return "performance";
  if (/simplifier/i.test(gate)) return "readability";
  if (/standards/i.test(gate)) return "style";
  return "correctness";
}

/**
 * The reviewer that owns an axis: the one with the fewest axes that claims it
 */
export function ownerOf(axis: Axis): Reviewer {
  return [...REVIEWERS].filter((reviewer) => REVIEWER_AXES[reviewer].includes(axis)).sort((a, b) => REVIEWER_AXES[a].length - REVIEWER_AXES[b].length)[0]!;
}

/**
 * The areas a signal's files fall in: each zone they hit, or else the review rule most of them fall under
 */
function areasOf(touches: Touch[]): string[] {
  const zones = [...new Set(touches.flatMap((touch) => touch.zones))].sort();
  if (zones.length > 0) return zones.map((zone) => `zone:${zone}`);
  if (touches.length === 0) return ["rules:unknown"];
  const counts = new Map<string, number>();
  for (const touch of touches) {
    const rule = vendoredRule(touch.path).replace(/\.md$/, "");
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  const [rule] = [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0]!;
  return [`rules:${rule}`];
}

/**
 * A stable id for a class, the same from any repo
 */
export function fingerprint(axis: Axis, area: string): string {
  return `q-${createHash("sha256").update(`quality|${axis}|${area}`).digest("hex").slice(0, 12)}`;
}

/**
 * The PR a later commit reverted, from the sha, PR number or title its message names
 */
function revertedPr(message: string, repo: string, prs: MergedPr[]): MergedPr | null {
  return (
    prs.find((pr) => pr.mergeSha !== null && message.includes(pr.mergeSha)) ??
    prs.find((pr) => message.includes(`Reverts ${repo}#${pr.number}`)) ??
    prs.find((pr) => message.startsWith(`Revert "${pr.title}`)) ??
    null
  );
}

/**
 * The merged PR a `fix:` commit most likely fixes
 *
 * Each file the fix touched points at the last PR before it that touched the same file, within
 * the window. The PR most files point at wins, and the later one breaks a tie.
 */
function fixedPr(commit: RepoData["commits"][number], prs: MergedPr[], windowMs: number): MergedPr | null {
  const at = Date.parse(commit.at);
  const before = prs.filter((pr) => pr.mergeSha !== commit.sha && Date.parse(pr.mergedAt) < at && at - Date.parse(pr.mergedAt) <= windowMs);
  const votes = new Map<MergedPr, number>();
  for (const file of commit.files) {
    if (BOOKKEEPING.test(file.path)) continue;
    const last = before.filter((pr) => pr.files.some((touch) => touch.path === file.path)).at(-1);
    if (last) votes.set(last, (votes.get(last) ?? 0) + 1);
  }
  return [...votes].sort(([a, x], [b, y]) => y - x || b.mergedAt.localeCompare(a.mergedAt))[0]?.[0] ?? null;
}

/**
 * Reads merged PRs and the commits after them for what slipped through, and clusters it into classes
 */
export function quality(repos: RepoData[], options: QualityOptions): QualityReport {
  const windowMs = options.windowDays * DAY;
  const signals: Signal[] = [];
  const counts = { human: 0, agent: 0, author: 0, reviewers: new Set<string>(), commentedPrs: new Set<string>(), fixCommits: 0, fixedPrs: new Set<string>(), revertCommits: 0, revertedPrs: new Set<string>() };
  const recorded: { key: string; pr: MergedPr }[] = [];

  for (const data of repos) {
    const { repo, prs } = data;
    const key = (pr: MergedPr) => `${repo}#${pr.number}`;
    for (const pr of prs) {
      if (pr.record) recorded.push({ key: key(pr), pr });
      for (const comment of pr.comments) {
        counts[comment.kind] += 1;
        if (comment.kind !== "human") continue;
        counts.reviewers.add(`${repo}/${comment.author}`);
        counts.commentedPrs.add(key(pr));
        const touches = comment.path === null ? pr.files : [{ path: comment.path, zones: comment.zones }];
        signals.push({ kind: "human", repo, pr, axis: axisOf(comment.body ?? ""), touches, text: comment.body ?? "", path: comment.path });
      }
    }
    for (const commit of data.commits) {
      if (/^(revert(\([^)]*\))?!?:|Revert ")/i.test(commit.subject)) {
        const pr = revertedPr(commit.message, repo, prs);
        if (!pr || Date.parse(commit.at) <= Date.parse(pr.mergedAt)) continue;
        counts.revertCommits += 1;
        counts.revertedPrs.add(key(pr));
        signals.push({ kind: "revert", repo, pr, axis: "correctness", touches: pr.files, text: commit.subject, path: null });
        continue;
      }
      const pr = fixedPr(commit, prs, windowMs);
      if (!pr) continue;
      counts.fixCommits += 1;
      counts.fixedPrs.add(key(pr));
      const touches = commit.files.filter((file) => !BOOKKEEPING.test(file.path));
      signals.push({ kind: "fix", repo, pr, axis: axisOf(commit.subject), touches, text: commit.subject, path: null });
      for (const skip of pr.record?.skipped ?? []) {
        signals.push({ kind: "skip", repo, pr, axis: gateAxis(skip.gate), touches, text: `${skip.gate} skipped (${skip.reason}), then ${commit.subject}`, path: null });
      }
    }
  }

  const gates = new Map<string, { skipped: number; laterFixed: number }>();
  let skipped = 0;
  let skippedThenFixed = 0;
  let cleanThenFixed = 0;
  for (const { key, pr } of recorded) {
    const fixed = counts.fixedPrs.has(key) || counts.revertedPrs.has(key);
    const names = [...new Set(pr.record!.skipped.map((skip) => skip.gate))];
    if (names.length > 0) {
      skipped += 1;
      if (fixed) skippedThenFixed += 1;
    } else if (fixed) {
      cleanThenFixed += 1;
    }
    for (const name of names) {
      const row = gates.get(name) ?? { skipped: 0, laterFixed: 0 };
      row.skipped += 1;
      if (fixed) row.laterFixed += 1;
      gates.set(name, row);
    }
  }

  const classes = new Map<string, MissedClass & { prSet: Set<string>; repoSet: Set<string>; hintPrs: Map<string, Set<string>> }>();
  for (const signal of signals) {
    for (const area of areasOf(signal.touches)) {
      const id = `${signal.axis}|${area}`;
      const entry = classes.get(id) ?? {
        fingerprint: fingerprint(signal.axis, area),
        axis: signal.axis,
        area,
        owner: ownerOf(signal.axis),
        score: 0,
        prs: 0,
        repos: 0,
        signals: { human: 0, fix: 0, revert: 0, skip: 0 },
        hints: [],
        examples: [],
        refs: [],
        prSet: new Set<string>(),
        repoSet: new Set<string>(),
        hintPrs: new Map<string, Set<string>>(),
      };
      entry.signals[signal.kind] += 1;
      entry.score += WEIGHTS[signal.kind];
      const prKey = `${signal.repo}#${signal.pr.number}`;
      entry.prSet.add(prKey);
      entry.repoSet.add(signal.repo);
      const hint = (text: string) => entry.hintPrs.set(text, (entry.hintPrs.get(text) ?? new Set<string>()).add(prKey));
      const record = signal.pr.record;
      if (record && area.startsWith("zone:") && !record.zones.includes(area.slice(5))) hint("zone not in the plan");
      if (record && area.startsWith("zone:") && !record.tiers.includes("T3")) hint("planned below T3");
      if (signal.kind === "skip") hint(`skipped ${signal.text.split(" skipped ")[0]} before the fix`);
      entry.examples.push({ repo: signal.repo, pr: signal.pr.number, kind: signal.kind, text: signal.text, path: signal.path });
      classes.set(id, entry);
    }
  }

  const ranked = [...classes.values()]
    .map(({ prSet, repoSet, hintPrs, examples, ...entry }) => ({
      ...entry,
      prs: prSet.size,
      repos: repoSet.size,
      refs: [...prSet].sort(),
      hints: [...hintPrs].sort(([a, x], [b, y]) => y.size - x.size || a.localeCompare(b)).map(([text, prs]) => `${text} on ${prs.size} PR${prs.size === 1 ? "" : "s"}`),
      // A person's words first, then reverts, fixes and skips.
      examples: [...examples].sort((a, b) => WEIGHTS[b.kind] - WEIGHTS[a.kind] || (a.kind === b.kind ? 0 : a.kind === "human" ? -1 : 1)).slice(0, 3),
    }))
    .sort((a, b) => b.score - a.score || b.prs - a.prs || a.axis.localeCompare(b.axis) || a.area.localeCompare(b.area))
    .slice(0, options.top);

  const merges = repos.flatMap((data) => data.prs.map((pr) => pr.mergedAt)).sort();
  return {
    sources: {
      repos: repos.map((data) => ({ repo: data.repo, prs: data.prs.length, records: data.prs.filter((pr) => pr.record).length, fetchedAt: data.fetchedAt })),
      prs: merges.length,
      records: recorded.length,
      from: merges[0] ?? null,
      to: merges.at(-1) ?? null,
      windowDays: options.windowDays,
    },
    comments: { human: counts.human, agent: counts.agent, author: counts.author, reviewers: counts.reviewers.size, prs: counts.commentedPrs.size },
    fixes: { commits: counts.fixCommits, prs: counts.fixedPrs.size },
    reverts: { commits: counts.revertCommits, prs: counts.revertedPrs.size },
    skips: {
      recorded: recorded.length,
      skipped,
      skippedThenFixed,
      cleanThenFixed,
      gates: [...gates].map(([gate, row]) => ({ gate, ...row })).sort((a, b) => b.skipped - a.skipped || a.gate.localeCompare(b.gate)),
    },
    classes: ranked,
  };
}

/**
 * The report as a few lines per section for a person
 */
export function renderQuality(report: QualityReport): string {
  const label = (name: string) => name.padEnd(9);
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const { sources, comments, fixes, reverts, skips } = report;
  const lines = [
    `${label("Sources")}${plural(sources.prs, "merged PR")} in ${plural(sources.repos.length, "repo")}, ${sources.records} with a gate record${sources.from ? `, merged ${sources.from.slice(0, 10)} to ${sources.to!.slice(0, 10)}` : ""}, fixes counted within ${sources.windowDays} days`,
    `${label("Comments")}${comments.human} human from ${plural(comments.reviewers, "reviewer")} on ${plural(comments.prs, "PR")}, ${comments.agent} from agents, ${comments.author} by authors`,
    `${label("Fixes")}${plural(fixes.commits, "fix commit")} on ${plural(fixes.prs, "PR")}`,
    `${label("Reverts")}${reverts.commits} on ${plural(reverts.prs, "PR")}`,
    `${label("Skips")}${skips.recorded} recorded PRs, ${skips.skipped} skipped a gate and ${skips.skippedThenFixed} of those needed a fix, ${skips.cleanThenFixed} of the rest needed one`,
    ...skips.gates.map((gate) => `${label("")}${gate.gate}: skipped on ${plural(gate.skipped, "PR")}, ${gate.laterFixed} later fixed`),
  ];
  if (report.classes.length === 0) lines.push(`${label("Classes")}none`);
  report.classes.forEach((entry, index) => {
    const parts = (Object.entries(entry.signals) as [SignalKind, number][]).filter(([, count]) => count > 0).map(([kind, count]) => `${count} ${kind}`);
    lines.push(`${label(index === 0 ? "Classes" : "")}${index + 1}. ${entry.axis} in ${entry.area}, owner ${entry.owner}, score ${entry.score}: ${parts.join(", ")} on ${plural(entry.prs, "PR")} [${entry.fingerprint}]${entry.hints.length > 0 ? `. ${entry.hints.join(", ")}` : ""}`);
  });
  return lines.join("\n");
}
