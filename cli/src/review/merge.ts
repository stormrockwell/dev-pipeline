import { type Finding, overlaps, rank, type ReportedFinding, type Reviewer, sameProblem, span } from "./findings.ts";
import { onFix } from "./route.ts";
import type { Merged, Scope } from "./state.ts";

// Nits beyond this many in one round go to the backlog, lowest precedence first.
export const NIT_CAP = 5;

export interface MergeInput {
  round: number;
  scope: Scope;
  head: string;
  reports: Map<Reviewer, ReportedFinding[]>;
  // The findings still open after the previous round.
  open: Finding[];
  // Findings taken out by an overrule or a dismissal, which never reach the fix list.
  removed: string[];
  fixLines: Record<string, number[]> | null;
}

/**
 * Precedence order: axis first, then Important before Nit, then by place in the code
 */
export function byPrecedence(a: Finding, b: Finding): number {
  return rank(a.axis) - rank(b.axis) || (a.tag === b.tag ? 0 : a.tag === "Important" ? -1 : 1) || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0);
}

/**
 * Merges a round's reports into one fix list
 *
 * A reviewer that ran re-reports each of its open findings it still sees, under the same id, so an
 * open finding it left out counts as fixed. New findings get ids. Pre-existing problems, and in a
 * fix round new findings off the fix diff, go to the backlog. Two findings on the same lines that
 * name the same problem keep the one with higher precedence. Two on the same lines from different
 * axes become a contest for the orchestrator to rule on, and the fix list orders them so the
 * higher one wins.
 */
export function mergeRound(input: MergeInput): Merged {
  const reported = new Set<string>();
  const fresh: Finding[] = [];
  for (const [reviewer, findings] of input.reports) {
    let next = 1;
    for (const finding of findings) {
      if (finding.id !== undefined) {
        reported.add(finding.id);
        fresh.push({ ...finding, id: finding.id, reviewer });
      } else {
        fresh.push({ ...finding, id: `${reviewer}-${input.round}.${next++}`, reviewer });
      }
    }
  }
  const ran = new Set(input.reports.keys());
  const fixed = input.open.filter((finding) => ran.has(finding.reviewer) && !reported.has(finding.id) && !input.removed.includes(finding.id)).map((finding) => finding.id);
  const carried = input.open.filter((finding) => !ran.has(finding.reviewer));
  const priorIds = new Set(input.open.map((finding) => finding.id));

  const backlog: Merged["backlog"] = [];
  const candidates: Finding[] = [];
  for (const finding of [...carried, ...fresh]) {
    if (finding.tag === "Pre-existing") backlog.push({ ...finding, why: "pre-existing" });
    else if (input.scope === "fix" && input.fixLines !== null && !priorIds.has(finding.id) && !onFix(finding, input.fixLines)) backlog.push({ ...finding, why: "outside the fix diff" });
    else candidates.push(finding);
  }

  const kept: Finding[] = [];
  const duplicates: Merged["duplicates"] = [];
  for (const finding of candidates.sort(byPrecedence)) {
    const twin = kept.find((other) => other.reviewer !== finding.reviewer && overlaps(other, finding) && sameProblem(other.title, finding.title));
    if (twin) {
      duplicates.push({ dropped: finding.id, kept: twin.id });
      twin.instances = [...(twin.instances ?? []), { file: finding.file, ...(finding.line !== undefined ? { line: finding.line } : {}) }, ...(finding.instances ?? [])];
    } else {
      kept.push(finding);
    }
  }

  // A finding waived or overruled was still opened, so it counts before it leaves the list.
  const opened = kept.filter((finding) => !priorIds.has(finding.id)).length;
  const live = kept.filter((finding) => !input.removed.includes(finding.id));
  const nits = live.filter((finding) => finding.tag === "Nit");
  const cut = new Set(nits.slice(NIT_CAP).map((finding) => finding.id));
  for (const finding of live) if (cut.has(finding.id)) backlog.push({ ...finding, why: "over the nit cap" });
  const accepted = live.filter((finding) => !cut.has(finding.id));

  const contests: Merged["contests"] = [];
  accepted.forEach((high, index) => {
    for (const low of accepted.slice(index + 1)) {
      if (high.reviewer !== low.reviewer && high.axis !== low.axis && overlaps(high, low)) contests.push({ high: high.id, low: low.id });
    }
  });

  return { head: input.head, accepted, backlog, duplicates, contests, fixed, opened };
}

/**
 * A finding's place in the code, as file and line range
 */
export function place(finding: Finding): string {
  const lines = span(finding);
  return lines === null ? finding.file : lines[0] === lines[1] ? `${finding.file}:${lines[0]}` : `${finding.file}:${lines[0]}-${lines[1]}`;
}

/**
 * The fix list the implementer works from, in precedence order
 */
export function renderFixList(merged: Merged, task: string, round: number, worktree: string): string {
  const items = merged.accepted.map((finding, index) => {
    const extra = (finding.instances ?? []).map((instance) => `${instance.file}${instance.line ? `:${instance.line}` : ""}`);
    return [
      `${index + 1}. \`${finding.id}\` ${finding.axis}, ${finding.tag}, ${place(finding)}`,
      `   ${finding.title}`,
      `   ${finding.detail.replace(/\n+/g, " ")}`,
      ...(finding.fix ? [`   Fix: ${finding.fix.replace(/\n+/g, " ")}`] : []),
      ...(extra.length > 0 ? [`   Also at: ${extra.join(", ")}`] : []),
    ].join("\n");
  });
  return [
    `# Fix list: task ${task}, round ${round}`,
    "",
    "Fix every item in the order listed. Where two items pull the same lines in opposite directions, follow the one listed first, because it outranks the other. When you think an item is wrong, leave the code as it is and say why under Disputed in your reply.",
    "",
    ...items,
    "",
    `Then commit, run \`pipeline tdd green --task ${worktree}\` on the fix commit, and reply with the report contract plus a Fixes section that names each id as fixed or disputed, with the reason for each dispute.`,
    "",
  ].join("\n");
}
