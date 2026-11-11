import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gitOut, workingTree } from "../../task/git.ts";
import { parseUnifiedDiff } from "../scan-zones/diff.ts";
import { isTestFile, scanFile } from "../scan-zones/scan.ts";
import type { Zone, ZoneConfig } from "../scan-zones/types.ts";
import { COMMENT_LINE, guardOf, type Mutant, mutantsOf, stackOf } from "./rules.ts";

// The zones whose checks this mutator disables, which are the ones a test must prove by failing without them.
const CHECK_ZONES: Zone[] = ["authz", "auth", "csrf"];

// Naming a check in an import brings it into scope and does not run it.
const IMPORT_LINE = /^\s*import\b/;

const diffFlags = ["-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/"];

/**
 * A changed line the scan reads as a security check and no mutation rule covers
 */
export interface Unmutated {
  file: string;
  line: number;
  zone: Zone;
  text: string;
}

export interface MutationPlan {
  mutants: Mutant[];
  unmutated: Unmutated[];
  files: string[];
}

/**
 * The security checks in a task's changed lines and the mutants that disable them
 *
 * The change is the working tree against the task's base, so uncommitted work counts. Test files are
 * left out, because a check inside one is not production code. A security line that no rule can
 * mutate is listed in `unmutated`, so a gap in the rules shows up instead of passing unseen.
 */
export function planMutants(worktree: string, base: string, config: ZoneConfig): MutationPlan {
  const diff = gitOut(worktree, ["diff", ...diffFlags, base, workingTree(worktree)]);
  const plan: MutationPlan = { mutants: [], unmutated: [], files: [] };

  for (const file of parseUnifiedDiff(diff)) {
    if (file.deleted || stackOf(file.path) === null || isTestFile(config, file.path)) continue;
    let content: string;
    try {
      content = readFileSync(join(worktree, file.path), "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    const added = new Set(file.added.map((entry) => entry.line));
    const scan = scanFile(config, { path: file.path, content, added, removed: [], deleted: false });
    const security = new Map<number, Zone>();
    for (const match of scan.matches) {
      if (match.kind === "signal" && match.line !== null && CHECK_ZONES.includes(match.zone)) security.set(match.line, match.zone);
    }

    const covered = new Set<number>();
    const found: Mutant[] = [];
    for (const number of [...added].sort((a, b) => a - b)) {
      const text = lines[number - 1] ?? "";
      const own = mutantsOf(file.path, number, text);
      if (own.length > 0) {
        covered.add(number);
        found.push(...own);
        continue;
      }
      let above = number - 2;
      while (above >= 0 && lines[above]!.trim() === "") above--;
      if (above < 0 || !security.has(above + 1) || mutantsOf(file.path, above + 1, lines[above]!).length > 0) continue;
      const guard = guardOf(file.path, number, text, lines[above]!);
      if (guard) {
        covered.add(above + 1);
        found.push(guard);
      }
    }

    for (const [line, zone] of [...security].sort((a, b) => a[0] - b[0])) {
      const text = lines[line - 1] ?? "";
      if (!covered.has(line) && !COMMENT_LINE.test(text) && !IMPORT_LINE.test(text)) plan.unmutated.push({ file: file.path, line, zone, text: text.trim().slice(0, 120) });
    }
    if (found.length > 0) plan.files.push(file.path);
    plan.mutants.push(...found);
  }
  return plan;
}
