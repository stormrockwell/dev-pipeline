import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const BASELINE_PATH = ".pipeline/a11y-baseline.json";

/**
 * One axe node that failed a rule, as the baseline remembers it
 */
export interface Violation {
  rule: string;
  // The URL path only, so a change of host or port between runs leaves the key alone.
  url: string;
  // The CSS selector axe computed for the node, joined across frames and shadow roots.
  selector: string;
}

/**
 * The accepted violations of a repo, written by `pipeline a11y --update-baseline`
 */
export interface Baseline {
  version: 1;
  target: string;
  violations: Violation[];
}

/**
 * The comparison of one scan with a baseline
 */
export interface Diff<T extends Violation = Violation> {
  added: T[];
  fixed: Violation[];
  kept: T[];
}

/**
 * The stable identity of a violation
 *
 * The HTML snippet is left out because it changes with any copy edit, which would turn an old
 * violation into a new one.
 */
export function violationKey(violation: Violation): string {
  return `${violation.rule}\u0000${violation.url}\u0000${violation.selector}`;
}

/**
 * Orders violations by page, then rule, then selector, so the file diffs cleanly
 */
function sorted<T extends Violation>(violations: T[]): T[] {
  return [...violations].sort((a, b) => a.url.localeCompare(b.url) || a.rule.localeCompare(b.rule) || a.selector.localeCompare(b.selector));
}

/**
 * Drops repeats of the same violation
 */
export function unique<T extends Violation>(violations: T[]): T[] {
  return [...new Map(violations.map((violation) => [violationKey(violation), violation])).values()];
}

/**
 * Splits a scan into violations the baseline lacks, ones it has, and ones it holds that no longer appear
 *
 * Only the pages the scan visited can be fixed, because a page left out of a run says nothing about its entries.
 */
export function diffBaseline<T extends Violation>(current: T[], baseline: Baseline | null, scanned: string[]): Diff<T> {
  const known = new Set((baseline?.violations ?? []).map(violationKey));
  const seen = new Set(current.map(violationKey));
  return {
    added: sorted(current.filter((violation) => !known.has(violationKey(violation)))),
    kept: sorted(current.filter((violation) => known.has(violationKey(violation)))),
    fixed: sorted((baseline?.violations ?? []).filter((violation) => scanned.includes(violation.url) && !seen.has(violationKey(violation)))),
  };
}

/**
 * Reads the baseline, or null when the repo has none yet
 */
export function readBaseline(path: string): Baseline | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const file = parsed as Partial<Baseline> | null;
  const entries = file?.violations;
  const valid = file?.version === 1 && Array.isArray(entries) && entries.every((entry) => [entry?.rule, entry?.url, entry?.selector].every((field) => typeof field === "string"));
  if (!valid) throw new Error(`${path} is not an a11y baseline, so delete it and record a new one with --update-baseline.`);
  return { version: 1, target: String(file.target ?? ""), violations: entries.map(({ rule, url, selector }) => ({ rule, url, selector })) };
}

/**
 * Records a scan, replacing the entries of the pages it visited and keeping every other page's
 */
export function writeBaseline(path: string, target: string, current: Violation[], scanned: string[], previous: Baseline | null): Baseline {
  const kept = (previous?.violations ?? []).filter((violation) => !scanned.includes(violation.url));
  const baseline: Baseline = { version: 1, target, violations: sorted(unique([...kept, ...current])) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}
