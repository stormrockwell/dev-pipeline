import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { git } from "../secrets/git.ts";
import { isScanned, isTestFile, scanFile } from "../scan-zones/scan.ts";
import { blank, functionName, functionRanges, innermost, type Range } from "../scan-zones/scope.ts";
import type { FileInput, FileScan, Zone, ZoneConfig } from "../scan-zones/types.ts";
import type { Reason } from "./tier.ts";

/**
 * Reach reasons for a file
 *
 * Returns one reason per changed helper, caller file and zone.
 */
export type Reacher = (config: ZoneConfig, input: FileInput) => Reason[];

// Callers inspected per function, so a name used everywhere cannot stall a run.
const MAX_CALLERS = 50;

const MAX_FUNCTIONS = 40;

const MAX_CALLER_BYTES = 1024 * 1024;

// A signal this many lines from a top level call site counts as near it, as it does in the scan.
const TOP_LEVEL_WINDOW = 20;

const MIN_NAME_LENGTH = 4;

// Names that would match unrelated code in any repo, or that a framework calls by convention.
const COMMON_NAMES = new Set([
  "init",
  "main",
  "test",
  "setup",
  "render",
  "handle",
  "build",
  "format",
  "parse",
  "load",
  "save",
  "reset",
  "update",
  "create",
  "delete",
  "close",
  "open",
  "start",
  "stop",
  "then",
  "catch",
  "emit",
  "data",
  "value",
  "name",
  "default",
  "constructor",
  "callback",
  "index",
  "register",
  "boot",
  "execute",
  "handler",
]);

const THIRD_PARTY = /(^|\/)(vendor|node_modules|\.git)\//;

interface Changed {
  name: string;
  start: number;
  end: number;
}

interface Caller {
  path: string;
  line: number;
}

interface Source {
  lines: string[];
  ranges: Range[];
  scan: FileScan;
}

function isComment(text: string): boolean {
  return /^\s*(\*|\/\/|\/\*|#)/.test(text);
}

function escapeRegex(name: string): string {
  return name.replace(/[$]/g, "\\$");
}

/**
 * Named functions a change touches
 *
 * A file read whole counts every function, and a diff counts
 * the ones with an added line inside them.
 */
function changedFunctions(input: FileInput): Changed[] {
  if (input.content === null || input.deleted) return [];
  const lines = input.content.split(/\r?\n/);
  const blanked = blank(lines);
  const ends = new Map<number, number>();
  for (const range of functionRanges(lines)) if (!ends.has(range.start)) ends.set(range.start, range.end);

  const found: Changed[] = [];
  for (let i = 0; i < blanked.length; i++) {
    const name = functionName(blanked[i]!);
    if (name === null || name.length < MIN_NAME_LENGTH || name.startsWith("__") || COMMON_NAMES.has(name.toLowerCase())) continue;
    const end = ends.get(i) ?? i;
    let touched = input.added === null;
    for (let line = i + 1; !touched && line <= end + 1; line++) touched = input.added!.has(line);
    if (touched) found.push({ name, start: i, end });
  }
  return found.slice(0, MAX_FUNCTIONS);
}

/**
 * Call sites of a name
 *
 * Found by a text search of the working tree. The search needs no index or language
 * server, so it runs in CI and in a sandbox.
 */
function callers(root: string, name: string): Caller[] {
  const pattern = `(^|[^[:alnum:]_$])${escapeRegex(name)}[[:space:]]*\\(`;
  const result = git(root, ["grep", "--no-index", "--exclude-standard", "-n", "-I", "-E", "-e", pattern]);
  if (!result.ok) return [];
  const found: Caller[] = [];
  for (const row of result.stdout.split("\n")) {
    const parsed = /^(.*?):(\d+):(.*)$/.exec(row);
    if (!parsed) continue;
    const [, path, line, text] = parsed as unknown as [string, string, string, string];
    if (!isScanned(path) || THIRD_PARTY.test(path) || isComment(text) || functionName(text) === name) continue;
    found.push({ path, line: Number(line) });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

/**
 * Builds a reacher for the repo at root
 *
 * A changed function that zone code calls is zone code, so
 * each such call site becomes a T3 reason in the zones it sits in.
 */
export function reachFinder(root: string): Reacher {
  const sources = new Map<string, Source | null>();

  const source = (config: ZoneConfig, path: string): Source | null => {
    if (sources.has(path)) return sources.get(path)!;
    let loaded: Source | null = null;
    try {
      const full = join(root, path);
      if (statSync(full).size <= MAX_CALLER_BYTES) {
        const content = readFileSync(full, "utf8");
        const lines = content.split(/\r?\n/);
        loaded = { lines, ranges: functionRanges(lines), scan: scanFile(config, { path, content, added: null, removed: [], deleted: false }) };
      }
    } catch {
      loaded = null;
    }
    sources.set(path, loaded);
    return loaded;
  };

  // A path rule covers the whole file, and a signal counts when it sits in the call's function or near it.
  const zonesAt = (loaded: Source, line: number): Zone[] => {
    const index = line - 1;
    const scope = innermost(loaded.ranges, index);
    const from = scope ? scope.start : index - TOP_LEVEL_WINDOW;
    const to = scope ? scope.end : index + TOP_LEVEL_WINDOW;
    const zones = new Set<Zone>();
    for (const match of loaded.scan.matches) {
      if (match.kind === "path" || (match.line !== null && match.line - 1 >= from && match.line - 1 <= to)) zones.add(match.zone);
    }
    return [...zones];
  };

  return (config, input) => {
    if (isTestFile(config, input.path)) return [];
    const reasons = new Map<string, Reason>();
    for (const changed of changedFunctions(input)) {
      let inspected = 0;
      for (const caller of callers(root, changed.name)) {
        if (caller.path === input.path && caller.line - 1 >= changed.start && caller.line - 1 <= changed.end) continue;
        if (++inspected > MAX_CALLERS) break;
        const loaded = source(config, caller.path);
        if (loaded === null) continue;
        for (const zone of zonesAt(loaded, caller.line)) {
          const key = `${changed.name}\0${caller.path}\0${zone}`;
          if (reasons.has(key)) continue;
          reasons.set(key, {
            file: caller.path,
            tier: "T3",
            rule: "reach",
            zone,
            line: caller.line,
            detail: `${changed.name}() changed in ${input.path} is called from zone:${zone} code`,
          });
        }
      }
    }
    return [...reasons.values()].sort(
      (a, b) => (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0) || (a.zone ?? "").localeCompare(b.zone ?? "") || a.detail.localeCompare(b.detail),
    );
  };
}
