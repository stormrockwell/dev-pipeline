import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, normalize, resolve } from "node:path";
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

/** Checks a path or glob, following symlinks when the target exists. */
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

/** The input fields that hold a path or a glob, for each tool the guard covers. */
const PATH_FIELDS: Record<string, string[]> = {
  Read: ["file_path"],
  Edit: ["file_path"],
  Write: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Grep: ["path", "glob"],
  Glob: ["path", "pattern"],
};

/** Returns a deny verdict when a file tool targets a secret, and undefined otherwise. */
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
