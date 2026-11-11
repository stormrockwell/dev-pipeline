import { loadConfig } from "../commands/scan-zones/config.ts";
import { collectRange } from "../commands/scan-zones/collect.ts";
import { matchesGlob } from "../commands/scan-zones/glob.ts";
import { groupsFor, scanFile } from "../commands/scan-zones/scan.ts";
import { gitOut, lines } from "../task/git.ts";
import { type Finding, type Reviewer, span } from "./findings.ts";
import { securityPlan } from "./security.ts";
import type { Scope } from "./state.ts";

/**
 * One hunk of a `git diff -U0`, with the old lines it replaced and the new lines it wrote
 */
export interface Hunk {
  file: string;
  oldStart: number;
  oldCount: number;
  added: { line: number; text: string }[];
  removed: string[];
}

export interface RouteInput {
  worktree: string;
  base: string;
  // Null for the first round.
  from: string | null;
  // The first round's diff size in added and removed lines, null for the first round.
  original: number | null;
  gates: string[];
  open: Finding[];
}

export interface Routing {
  scope: Scope;
  reviewers: Reviewer[];
  reasons: Partial<Record<Reviewer, string>>;
  // Reviews the diff calls for that this plugin version does not ship.
  unbuilt: { gate: string; reason: string }[];
  zoneFiles: string[];
  changed: number;
  fixLines: Record<string, number[]> | null;
  // Where the security diff starts, and whether it holds PHP, when the tier has a security gate.
  security: { from: string; php: boolean } | null;
}

// Lines either side of a finding that a fix may still touch without changing behavior beyond it.
const SLACK = 3;
// A fix diff past this many added and removed lines counts as substantial for the simplifier and standards.
const SUBSTANTIAL = 20;

const FUNCTION = /\bfunction\b|=>|^\s*(?:public|private|protected|static|async)\s+[\w$]+\s*\(|^\s*def\s|\bclass\s+[\w$]/;
const BRANCH = /\b(?:if|else|elseif|switch|case|catch|for|foreach|while)\b|\?\?|\?[^:?]+:/;
const PERFORMANCE = /\$wpdb->|\bWP_Query\b|\bget_posts\s*\(|\bget_(?:post|user|term)_meta\s*\(|\bSELECT\b|\bwp_remote_(?:get|post|request|head)\b|\bfetch\s*\(|\baxios\b|\bhttps?\.(?:get|request)\b|add_action\s*\(\s*['"](?:init|wp_loaded|template_redirect|wp_head|wp_footer)['"]|\bforeach\b|\b(?:for|while)\s*\(|\.(?:map|forEach|reduce)\s*\(/;
const FRONT_END = /\.(?:jsx|tsx|vue|svelte)$|(?:^|\/)(?:assets|blocks|components|public|templates)\//;

/**
 * Parses `git diff -U0` into hunks that keep the old line numbers, which findings refer to
 */
export function parseHunks(text: string): Hunk[] {
  const hunks: Hunk[] = [];
  let file: string | null = null;
  let current: Hunk | null = null;
  let newLine = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = /^diff --git a\/.* b\/(.*)$/.exec(line)?.[1] ?? null;
      current = null;
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header && file !== null) {
      current = { file, oldStart: Number(header[1]), oldCount: header[2] === undefined ? 1 : Number(header[2]), added: [], removed: [] };
      newLine = Number(header[3]);
      hunks.push(current);
      continue;
    }
    if (current === null || line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) current.added.push({ line: newLine++, text: line.slice(1) });
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
  return hunks;
}

/**
 * The hunks between two commits of the worktree
 */
function diffHunks(worktree: string, from: string, to = "HEAD"): Hunk[] {
  return parseHunks(gitOut(worktree, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", from, to, "--"]));
}

/**
 * The changed lines of a diff, added and removed
 */
export function diffSize(worktree: string, from: string, to = "HEAD"): number {
  return diffHunks(worktree, from, to).reduce((sum, hunk) => sum + hunk.added.length + hunk.removed.length, 0);
}

/**
 * The files of a diff that carry zone code, by the same scan `pipeline scan-zones` runs
 */
function zoneFiles(worktree: string, from: string): string[] {
  const collected = collectRange(worktree, `${from}..HEAD`);
  if (!collected.ok) return [];
  const config = loadConfig(collected.collected.root);
  return collected.collected.inputs.filter((input) => scanFile(config, input).zones.length > 0).map((input) => input.path);
}

/**
 * The reviewers a task's gates name, simplifier first because it edits before the rest read
 */
function reviewersFor(gates: string[]): Reviewer[] {
  return [
    ...(gates.some((gate) => gate.startsWith("simplifier")) ? (["simplifier"] as const) : []),
    ...(gates.includes("spec") ? (["spec"] as const) : []),
    ...(gates.includes("standards") ? (["standards"] as const) : []),
    ...(securityPlan(gates) !== null ? (["security"] as const) : []),
  ];
}

/**
 * Where a security pass starts and whether its diff holds PHP
 */
function securityDiff(worktree: string, from: string): { from: string; php: boolean } {
  return { from, php: lines(gitOut(worktree, ["diff", "--name-only", "--no-renames", from, "HEAD", "--"])).some((file) => file.endsWith(".php")) };
}

/**
 * Whether a hunk writes more of a construct than it removes, so a rewritten line that keeps its one arrow function adds none
 */
function grows(hunk: Hunk, pattern: RegExp): boolean {
  const count = (texts: string[]) => texts.reduce((sum, text) => sum + (text.match(new RegExp(pattern.source, "g"))?.length ?? 0), 0);
  return count(hunk.added.map((entry) => entry.text)) > count(hunk.removed);
}

/**
 * Whether a hunk changes lines no open finding of its file named
 */
function beyondFindings(hunk: Hunk, open: Finding[]): boolean {
  const named = open.filter((finding) => finding.file === hunk.file);
  if (named.some((finding) => span(finding) === null)) return false;
  const [from, to] = [hunk.oldStart, hunk.oldStart + Math.max(hunk.oldCount, 1) - 1];
  return !named.some((finding) => {
    const [start, end] = span(finding)!;
    return from <= end + SLACK && start - SLACK <= to;
  });
}

/**
 * Decides which reviewers a round needs, by the routing table in STRATEGY section 7
 *
 * The first round, a fix diff over a third of the original, and a fix that adds files are full
 * rounds for every applicable reviewer. A smaller fix goes to each reviewer whose findings it
 * fixes, to spec when it changes code beyond the lines a finding named, and to the simplifier and
 * standards when it adds functions or branches or runs past about twenty lines.
 */
export function route(input: RouteInput): Routing {
  const applicable = reviewersFor(input.gates);
  const start = input.from ?? input.base;
  const hunks = diffHunks(input.worktree, start);
  const changed = hunks.reduce((sum, hunk) => sum + hunk.added.length + hunk.removed.length, 0);
  const zones = zoneFiles(input.worktree, start);
  const unbuilt: Routing["unbuilt"] = [];
  const added = hunks.flatMap((hunk) => hunk.added.map((entry) => ({ file: hunk.file, ...entry })));
  if (added.some((entry) => PERFORMANCE.test(entry.text))) unbuilt.push({ gate: "performance", reason: "the diff has queries, loops or remote calls, and the performance reviewer ships in 3.5" });
  if (hunks.some((hunk) => groupsFor(hunk.file).some((group) => group === "markup" || group === "css") || FRONT_END.test(hunk.file))) {
    unbuilt.push({ gate: "accessibility", reason: "the diff touches markup, CSS or front-end code, and the accessibility pass ships in 3.6" });
  }

  const newFiles = input.from === null ? [] : lines(gitOut(input.worktree, ["diff", "--name-only", "--diff-filter=A", "--no-renames", start, "HEAD"]));
  const full = input.from === null || input.original === null || changed * 3 > input.original || newFiles.length > 0;
  if (full) {
    const why = input.from === null ? "the first round reviews the whole diff" : newFiles.length > 0 ? `the fix adds ${newFiles.join(", ")}, so it counts as new code` : `the fix changes ${changed} lines, over a third of the ${input.original}-line original`;
    // A full round reviews the whole task diff, so the simplifier's zone files come from all of it.
    const wholeZones = input.from === null ? zones : zoneFiles(input.worktree, input.base);
    const security = applicable.includes("security") ? securityDiff(input.worktree, input.base) : null;
    return { scope: "full", reviewers: applicable, reasons: Object.fromEntries(applicable.map((reviewer) => [reviewer, why])), unbuilt, zoneFiles: wholeZones, changed, fixLines: null, security };
  }

  const reasons: Partial<Record<Reviewer, string>> = {};
  for (const reviewer of applicable) {
    const ids = input.open.filter((finding) => finding.reviewer === reviewer).map((finding) => finding.id);
    if (ids.length > 0) reasons[reviewer] = `checks whether the fix addressed ${ids.join(", ")}`;
  }
  const config = loadConfig(input.worktree);
  const isTest = (file: string) => config.testPaths.some((glob) => matchesGlob(glob, file));
  const beyond = hunks.find((hunk) => !isTest(hunk.file) && beyondFindings(hunk, input.open));
  if (applicable.includes("spec") && beyond) reasons.spec ??= `the fix changes ${beyond.file} near line ${beyond.oldStart}, beyond the lines a finding named`;
  const shape = hunks.find((hunk) => grows(hunk, FUNCTION) || grows(hunk, BRANCH));
  const substantial = changed > SUBSTANTIAL ? `the fix changes ${changed} lines` : shape ? `the fix adds a function or branch at ${shape.file}:${shape.added[0]?.line ?? shape.oldStart}` : null;
  if (substantial) {
    for (const reviewer of ["simplifier", "standards"] as const) if (applicable.includes(reviewer)) reasons[reviewer] ??= substantial;
  }

  // Security re-reviews every fix, and a fix in zone code can open a hole anywhere in the task.
  let security: Routing["security"] = null;
  if (applicable.includes("security")) {
    reasons.security = zones.length > 0 ? `the fix touches zone code in ${zones.join(", ")}, so security reads the whole task diff` : "security re-reviews every fix";
    security = securityDiff(input.worktree, zones.length > 0 ? input.base : start);
  }

  const fixLines: Record<string, number[]> = {};
  for (const entry of added) (fixLines[entry.file] ??= []).push(entry.line);
  // Deletions leave no line at HEAD, so the line after one stands for it.
  for (const hunk of hunks) if (hunk.added.length === 0) (fixLines[hunk.file] ??= []).push(hunk.oldStart);
  return { scope: "fix", reviewers: applicable.filter((reviewer) => reasons[reviewer] !== undefined), reasons, unbuilt, zoneFiles: zones, changed, fixLines, security };
}

/**
 * Whether a finding sits on lines a fix diff changed, give or take a few lines
 */
export function onFix(finding: { file: string; line?: number; end_line?: number }, fixLines: Record<string, number[]>): boolean {
  const touched = fixLines[finding.file];
  if (!touched) return false;
  const lines = span(finding);
  if (lines === null) return true;
  return touched.some((line) => line >= lines[0] - SLACK && line <= lines[1] + SLACK);
}
