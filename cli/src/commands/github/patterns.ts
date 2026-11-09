/** Expands `{a,b}` groups, including nested groups and empty alternatives, because GitHub patterns have no braces. */
export function expandBraces(glob: string): string[] {
  const open = glob.indexOf("{");
  if (open === -1) return [glob];

  let depth = 0;
  let close = -1;
  const cuts: number[] = [];
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === "{") depth++;
    else if (glob[i] === "}" && --depth === 0) {
      close = i;
      break;
    } else if (glob[i] === "," && depth === 1) cuts.push(i);
  }
  if (close === -1) return [glob];

  const bounds = [open, ...cuts, close];
  const alternatives = bounds.slice(0, -1).map((start, index) => glob.slice(start + 1, bounds[index + 1]));
  const before = glob.slice(0, open);
  const after = glob.slice(close + 1);
  return alternatives.flatMap((alternative) => expandBraces(`${before}${alternative}${after}`));
}

/**
 * Translates scan globs into the patterns a ruleset takes. The scan matches from any directory
 * boundary and the ruleset matches from the repo root, so each pattern also gets a `**\/` form.
 */
export function rulesetPatterns(globs: string[]): string[] {
  const patterns = globs.flatMap(expandBraces).flatMap((pattern) => (pattern.startsWith("**/") ? [pattern] : [pattern, `**/${pattern}`]));
  return [...new Set(patterns)];
}
