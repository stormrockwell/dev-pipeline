import { extname } from "node:path";
import { isCommentOnlyChange } from "./comments.ts";
import { globToRegExp } from "./glob.ts";
import { functionRanges, innermost, type Range } from "./scope.ts";
import type { FileInput, FileScan, Group, Match, Signal, Zone, ZoneConfig } from "./types.ts";

// Which signal groups apply to which file types. Suppressions apply to every scanned type.
const groupsByExtension: Record<string, Group[]> = {
  ".php": ["php", "markup", "suppressions"],
  ".inc": ["php", "markup", "suppressions"],
  ".phtml": ["php", "markup", "suppressions"],
  ".js": ["js", "suppressions"],
  ".jsx": ["js", "suppressions"],
  ".mjs": ["js", "suppressions"],
  ".cjs": ["js", "suppressions"],
  ".ts": ["js", "suppressions"],
  ".tsx": ["js", "suppressions"],
  ".mts": ["js", "suppressions"],
  ".cts": ["js", "suppressions"],
  ".css": ["css", "markup", "suppressions"],
  ".scss": ["css", "markup", "suppressions"],
  ".html": ["markup", "suppressions"],
  ".htm": ["markup", "suppressions"],
  ".sql": ["sql", "suppressions"],
};

export function groupsFor(path: string): Group[] {
  return groupsByExtension[extname(path).toLowerCase()] ?? [];
}

export function isScanned(path: string): boolean {
  return groupsFor(path).length > 0;
}

// Lines on each side of a write that count as "nearby" when the write sits outside any function.
const TOP_LEVEL_WINDOW = 20;

const SNIPPET_LENGTH = 120;

function snippet(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > SNIPPET_LENGTH ? `${trimmed.slice(0, SNIPPET_LENGTH - 3)}...` : trimmed;
}

interface Compiled {
  signal: Signal;
  pattern: RegExp;
  near: RegExp | null;
}

const compiledCache = new WeakMap<ZoneConfig, Compiled[]>();
const pathCache = new WeakMap<ZoneConfig, { regex: RegExp; zone: Zone; glob: string }[]>();

function compiled(config: ZoneConfig): Compiled[] {
  let list = compiledCache.get(config);
  if (!list) {
    list = config.signals.map((signal) => ({
      signal,
      pattern: new RegExp(signal.pattern, signal.flags ?? ""),
      near: signal.near ? new RegExp(signal.near, signal.flags ?? "") : null,
    }));
    compiledCache.set(config, list);
  }
  return list;
}

const testPathCache = new WeakMap<ZoneConfig, RegExp[]>();

// Test globs match case sensitively, so `*Test.php` finds FooTest.php and leaves latest.php alone.
export function isTestFile(config: ZoneConfig, path: string): boolean {
  let list = testPathCache.get(config);
  if (!list) {
    list = config.testPaths.map((glob) => globToRegExp(glob, false));
    testPathCache.set(config, list);
  }
  return list.some((regex) => regex.test(path));
}

function pathRules(config: ZoneConfig) {
  let list = pathCache.get(config);
  if (!list) {
    list = config.paths.map((rule) => ({ regex: globToRegExp(rule.glob), zone: rule.zone, glob: rule.glob }));
    pathCache.set(config, list);
  }
  return list;
}

// Matches a signal's `near` pattern against the function around a line, the hunk, or a window.
class Neighbourhood {
  private ranges: Range[] | null = null;
  private readonly lines: string[];
  private readonly added: Set<number> | null;

  constructor(lines: string[], added: Set<number> | null) {
    this.lines = lines;
    this.added = added;
  }

  private functions(): Range[] {
    return (this.ranges ??= functionRanges(this.lines));
  }

  holds(near: RegExp, index: number): boolean {
    const scope = innermost(this.functions(), index);
    const from = scope ? scope.start : Math.max(0, index - TOP_LEVEL_WINDOW);
    const to = scope ? scope.end : Math.min(this.lines.length - 1, index + TOP_LEVEL_WINDOW);
    for (let i = from; i <= to; i++) if (near.test(this.lines[i]!)) return true;
    return this.hunkHolds(near, index);
  }

  // Added lines next to each other form a hunk, and request data in the same hunk counts.
  private hunkHolds(near: RegExp, index: number): boolean {
    const added = this.added;
    if (!added) return false;
    let first = index + 1;
    let last = index + 1;
    while (added.has(first - 1)) first--;
    while (added.has(last + 1)) last++;
    for (let number = first; number <= last; number++) {
      if (near.test(this.lines[number - 1] ?? "")) return true;
    }
    return false;
  }
}

function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

// Rebuilds a sparse file from the added lines of a diff when the full content could not be read.
export function sparseContent(added: { line: number; text: string }[]): string {
  const lines: string[] = [];
  for (const entry of added) lines[entry.line - 1] = entry.text;
  return Array.from(lines, (line) => line ?? "").join("\n");
}

export function scanFile(config: ZoneConfig, input: FileInput): FileScan {
  const matches: Match[] = [];
  const removed: Match[] = [];

  // A comment cannot change a schema, but a comment in a guardrails file can carry a directive, so only data-loss rules look.
  let commentsOnly: boolean | undefined;
  for (const rule of pathRules(config)) {
    if (rule.regex.test(input.path)) {
      if (rule.zone === "data-loss") {
        commentsOnly ??= isCommentOnlyChange(input);
        if (commentsOnly) continue;
      }
      matches.push({ kind: "path", zone: rule.zone, line: null, pattern: rule.glob, text: input.path });
    }
  }

  const groups = groupsFor(input.path);
  if (groups.length > 0) {
    // A test file keeps the secrets zone, because a real credential committed as a fixture still leaks.
    const inTest = isTestFile(config, input.path);
    const signals = compiled(config).filter(({ signal }) => groups.includes(signal.group) && (!inTest || signal.zone === "secrets"));

    if (input.content !== null && !input.deleted) {
      const lines = splitLines(input.content);
      const around = new Neighbourhood(lines, input.added);
      for (let i = 0; i < lines.length; i++) {
        const number = i + 1;
        if (input.added && !input.added.has(number)) continue;
        const line = lines[i]!;
        if (line.length > 4000) continue;
        for (const { signal, pattern, near } of signals) {
          if (signal.only === "removed" || !pattern.test(line)) continue;
          if (near && !around.holds(near, i)) continue;
          matches.push({ kind: "signal", zone: signal.zone, line: number, pattern: signal.pattern, text: snippet(line) });
        }
      }
    }

    // A removed line cannot show request data, so a signal that depends on its neighbourhood is skipped.
    for (const entry of input.removed) {
      if (entry.text.length > 4000) continue;
      for (const { signal, pattern, near } of signals) {
        if (near || !pattern.test(entry.text)) continue;
        removed.push({ kind: "signal", zone: signal.zone, line: entry.line, pattern: signal.pattern, text: snippet(entry.text) });
      }
    }
  }

  const zones = [...new Set([...removed, ...matches].map((match) => match.zone))].sort();
  return { path: input.path, zones, matches, removed };
}

// Scans plain text as a whole file, which is how the unit tests and `classify` read a path list.
export function scanText(config: ZoneConfig, path: string, content: string): FileScan {
  return scanFile(config, { path, content, added: null, removed: [], deleted: false });
}
