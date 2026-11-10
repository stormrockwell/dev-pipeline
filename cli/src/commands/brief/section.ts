/**
 * The text of a work order's "## Task <id>" section, heading included, or null when it has none
 *
 * The section runs to the next heading at its level or above. Headings inside code fences do not
 * count, and the id must match whole, so Task 1 never picks up Task 1.1 or Task 12.
 */
export function taskSection(source: string, id: string): string | null {
  const lines = source.split(/\r?\n/);
  let fenced = false;
  let level = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#+)\s+(.*)$/.exec(line);
    if (heading && level > 0 && heading[1]!.length <= level) break;
    if (heading && level === 0) {
      const task = /^Task\s+([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)(?![A-Za-z0-9.])/.exec(heading[2]!);
      if (task?.[1] === id) level = heading[1]!.length;
    }
    if (level > 0) kept.push(line);
  }
  return level > 0 ? kept.join("\n").trim() : null;
}
