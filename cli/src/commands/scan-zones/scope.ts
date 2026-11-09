export interface Range {
  start: number;
  end: number;
}

// Control keywords share the `name(...) {` shape of a method, so they must not open a function scope.
const notMethods = new Set(["if", "for", "foreach", "while", "switch", "catch", "elseif", "with", "return"]);

const method =
  /^\s*(?:(?:public|private|protected|static|async|final|abstract|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{\s*$/;

/**
 * Blanks out strings and comments so a brace or a keyword inside them does not count. The scan is
 * line based and keeps block comment state across lines, which is enough to find function bodies
 * without a parser.
 */
export function blank(lines: string[]): string[] {
  let inBlock = false;
  return lines.map((line) => {
    if (line.length > 4000) return "";
    let out = "";
    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;
      const next = line[i + 1];
      if (inBlock) {
        if (char === "*" && next === "/") {
          inBlock = false;
          i++;
        }
      } else if (char === "/" && next === "*") {
        inBlock = true;
        i++;
      } else if ((char === "/" && next === "/") || char === "#") {
        break;
      } else if (char === "'" || char === '"' || char === "`") {
        for (i++; i < line.length && line[i] !== char; i++) if (line[i] === "\\") i++;
        out += '""';
      } else {
        out += char;
      }
    }
    return out;
  });
}

function startsFunction(line: string): boolean {
  if (/\bfunction\b/.test(line) || /=>\s*\{/.test(line)) return true;
  const name = method.exec(line)?.[1];
  return name !== undefined && !notMethods.has(name);
}

// Finds the closing line of the body that opens at or after `from`, or -1 when there is no body.
function bodyEnd(blanked: string[], from: number): number {
  let depth = 0;
  let opened = false;
  for (let i = from; i < blanked.length; i++) {
    const line = blanked[i]!;
    for (let col = 0; col < line.length; col++) {
      const char = line[col]!;
      if (char === "{") {
        depth++;
        opened = true;
      } else if (char === "}" && opened && --depth === 0) {
        return i;
      } else if (char === ";" && !opened) {
        return -1;
      }
    }
    if (!opened && i - from >= 3) return -1;
  }
  return -1;
}

// Zero-based line ranges of function and method bodies, which bound a "same function" check.
export function functionRanges(lines: string[]): Range[] {
  const blanked = blank(lines);
  const ranges: Range[] = [];
  for (let i = 0; i < blanked.length; i++) {
    if (!startsFunction(blanked[i]!)) continue;
    const end = bodyEnd(blanked, i);
    if (end >= 0) ranges.push({ start: i, end });
  }
  return ranges;
}

// The smallest range that holds the line, so a nested closure wins over the function around it.
export function innermost(ranges: Range[], index: number): Range | null {
  let best: Range | null = null;
  for (const range of ranges) {
    if (range.start <= index && index <= range.end && (!best || range.end - range.start < best.end - best.start)) best = range;
  }
  return best;
}
