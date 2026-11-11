import { type Baseline, type Diff, diffBaseline, unique, writeBaseline } from "./baseline.ts";
import { type AxeRunner, type Found, pathOf, violationsOf } from "./runner.ts";

export interface ScanInput {
  runner: AxeRunner;
  urls: string[];
  tags: string[];
  target: string;
  baseline: Baseline | null;
  baselinePath: string;
  record: boolean;
}

export interface ScanOutcome {
  scanned: string[];
  diff: Diff<Found>;
  recorded: boolean;
}

/**
 * Scans each page, then compares the result with the baseline or records it as the new one
 *
 * A page that cannot be scanned throws, so the caller fails the run instead of passing on partial results.
 */
export async function scanPages(input: ScanInput): Promise<ScanOutcome> {
  const found: Found[] = [];
  for (const url of input.urls) found.push(...violationsOf(await input.runner.scan(url, input.tags)));
  const current = unique(found);
  const scanned = [...new Set(input.urls.map(pathOf))];
  const diff = diffBaseline(current, input.baseline, scanned);
  if (input.record) writeBaseline(input.baselinePath, input.target, current, scanned, input.baseline);
  return { scanned, diff, recorded: input.record };
}
