import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";
import { expandBraces } from "./shell.ts";
import { verdict, type Verdict } from "./verdict.ts";

const KEY_EXTENSIONS = [".pem", ".key", ".p12"];

function expandHome(path: string): string {
  const home = homedir();
  if (path === "~" || path.startsWith("~/")) return home + path.slice(1);
  return path.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
}

function isSensitive(path: string): boolean {
  const name = basename(path);
  const lower = name.toLowerCase();
  if (name.startsWith(".env") && name !== ".env.example") return true;
  if (name === "wp-config.php" || name === "auth.json") return true;
  if (KEY_EXTENSIONS.some((extension) => lower.endsWith(extension))) return true;
  return path.split("/").includes(".ssh");
}

const MAX_GLOB_ENTRIES = 5000;

function hasGlob(word: string): boolean {
  return /[*?[]/.test(word);
}

function segmentPattern(segment: string): RegExp {
  let source = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === "*") {
      while (segment[i + 1] === "*") i++;
      source += "[^/]*";
    } else if (c === "?") source += "[^/]";
    else if (c === "[" && segment.indexOf("]", i + 2) !== -1) {
      const end = segment.indexOf("]", i + 2);
      source += `[${segment.slice(i + 1, end).replace(/^!/, "^").replaceAll("\\", "\\\\")}]`;
      i = end;
    } else source += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

// Expands a shell glob against the real directory tree, so only files that exist count.
function expandGlob(word: string, cwd: string): string[] {
  const absolute = isAbsolute(word) ? normalize(word) : resolve(cwd, word);
  const segments = absolute.split("/").filter(Boolean);
  let paths = ["/"];
  let budget = MAX_GLOB_ENTRIES;
  for (const segment of segments) {
    const next: string[] = [];
    for (const base of paths) {
      if (!hasGlob(segment)) {
        next.push(join(base, segment));
        continue;
      }
      const pattern = segmentPattern(segment);
      let names: string[] = [];
      try {
        names = readdirSync(base).slice(0, budget);
      } catch {
        // A directory that cannot be listed matches nothing.
      }
      budget -= names.length;
      for (const name of names) {
        if (name.startsWith(".") && !segment.startsWith(".")) continue;
        if (pattern.test(name)) next.push(join(base, name));
      }
    }
    paths = next;
  }
  return paths;
}

/**
 * Checks one command-line word. The word may be a plain path, a glob, or a wrapper around
 * one, such as `--file=.env`, `host:.env`, `@.env` or `HEAD:.env`.
 */
export function wordIsSensitive(word: string, cwd: string): boolean {
  const candidates = new Set([
    word,
    word.slice(word.indexOf("=") + 1),
    word.slice(word.lastIndexOf(":") + 1),
    word.replace(/^@/, ""),
  ]);
  for (const candidate of candidates) {
    if (candidate === "") continue;
    if (hasGlob(candidate)) {
      if (expandGlob(expandHome(candidate), cwd).some(isSensitive)) return true;
    } else if (pathIsSensitive(candidate, cwd)) return true;
  }
  return false;
}

// Checks a path or glob, following symlinks when the target exists.
export function pathIsSensitive(raw: string, cwd: string): boolean {
  for (const variant of expandBraces(expandHome(raw))) {
    const absolute = isAbsolute(variant) ? normalize(variant) : resolve(cwd, variant);
    if (isSensitive(absolute)) return true;
    try {
      if (existsSync(absolute) && isSensitive(realpathSync(absolute))) return true;
    } catch {
      // An unreadable path is judged by its name alone.
    }
  }
  return false;
}

export interface ToolInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

// The input fields that hold a path or a glob, for each tool the guard covers.
const PATH_FIELDS: Record<string, string[]> = {
  Read: ["file_path"],
  Edit: ["file_path"],
  Write: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Grep: ["path", "glob"],
  Glob: ["path", "pattern"],
};

// Returns a deny verdict when a file tool targets a secret, and undefined otherwise.
export function checkToolPaths(input: ToolInput, cwd: string): Verdict | undefined {
  const fields = PATH_FIELDS[input.tool_name ?? ""];
  if (!fields) return undefined;
  for (const field of fields) {
    const value = input.tool_input?.[field];
    if (typeof value === "string" && value !== "" && pathIsSensitive(value, cwd)) {
      return verdict(
        "deny",
        "sensitive-path",
        `${input.tool_name} on ${value} is denied because it holds secrets. Use .env.example for placeholders`,
      );
    }
  }
  return undefined;
}
