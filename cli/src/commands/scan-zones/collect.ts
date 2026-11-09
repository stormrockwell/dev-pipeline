import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { git, repoTop } from "../secrets/git.ts";
import { parseUnifiedDiff, type ChangedFile } from "./diff.ts";
import { isScanned, sparseContent } from "./scan.ts";
import type { FileInput } from "./types.ts";

/**
 * Directories a tree scan skips, because the repo does not own their code or they repeat the source
 * they were built from. Diff modes still scan them, since a plugin ships its build output and a change
 * made only there must reach a reviewer.
 */
const SKIP_DIRS = new Set(["vendor", "node_modules", ".git", "dist", "build"]);

/** Third party code stays skipped in a git repo, but committed build output counts as the repo's own. */
const THIRD_PARTY_DIRS = new Set(["vendor", "node_modules", ".git"]);

/** Files above this size are generated bundles or data, which no reviewer reads line by line. */
const MAX_BYTES = 5 * 1024 * 1024;

const diffFlags = ["-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/"];

export interface Collected {
  /** The repo or directory that holds .pipeline/sensitive.yml. */
  root: string;
  inputs: FileInput[];
}

function asText(buffer: Buffer): string | null {
  return buffer.includes(0) ? null : buffer.toString("utf8");
}

/**
 * The files git would commit, relative to `dir`, or null outside a git repo. A tree scan of ignored
 * output (`.claude/`, `public/build`, `.next`) reports code that no change can ever carry.
 */
function committableFiles(dir: string): string[] | null {
  const listing = git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (!listing.ok) return null;
  // A path can appear twice while a merge is unresolved, and a deleted or linked entry is not a file.
  const paths = new Set(listing.stdout.split("\0").filter(Boolean));
  return [...paths].filter((path) => {
    if (path.split("/").some((part) => THIRD_PARTY_DIRS.has(part))) return false;
    return lstatSync(join(dir, path), { throwIfNoEntry: false })?.isFile() === true;
  });
}

function walkFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        found.push(relative(dir, full).split("\\").join("/"));
      }
    }
  };
  walk(dir);
  return found;
}

export function collectTree(dir: string): Collected {
  const paths = committableFiles(dir) ?? walkFiles(dir);
  const inputs = paths.map((path): FileInput => {
    const readable = isScanned(path) && statSync(join(dir, path)).size <= MAX_BYTES;
    return { path, content: readable ? asText(readFileSync(join(dir, path))) : null, added: null, removed: [], deleted: false };
  });
  inputs.sort((a, b) => a.path.localeCompare(b.path));
  return { root: dir, inputs };
}

/** Reads named files from the working tree, for callers that already know which files they care about. */
export function collectFiles(root: string, files: string[]): Collected {
  const inputs = files.map((path): FileInput => {
    const full = join(root, path);
    let content: string | null = null;
    try {
      if (isScanned(path) && statSync(full).size <= MAX_BYTES) content = asText(readFileSync(full));
    } catch {
      content = null;
    }
    return { path, content, added: null, removed: [], deleted: content === null && !exists(full) };
  });
  return { root, inputs };
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function blob(top: string, spec: string): string | null {
  const result = spawnSync("git", ["show", spec], { cwd: top, maxBuffer: MAX_BYTES * 2 });
  return result.status === 0 ? asText(result.stdout) : null;
}

function toInput(file: ChangedFile, content: string | null): FileInput {
  const readable = isScanned(file.path) && !file.deleted;
  const text = readable ? (content ?? sparseContent(file.added)) : null;
  return {
    path: file.path,
    content: text,
    added: new Set(file.added.map((entry) => entry.line)),
    removed: file.removed,
    deleted: file.deleted,
  };
}

export type DiffResult = { ok: true; collected: Collected } | { ok: false; error: string };

export function collectStaged(dir: string): DiffResult {
  const top = repoTop(dir);
  if (top === null) return { ok: false, error: "--staged must run inside a git repository." };
  const diff = git(top, ["diff", "--cached", ...diffFlags]);
  if (!diff.ok) return { ok: false, error: `git diff --cached failed: ${diff.stderr.trim()}` };
  const inputs = parseUnifiedDiff(diff.stdout).map((file) => toInput(file, isScanned(file.path) ? blob(top, `:${file.path}`) : null));
  return { ok: true, collected: { root: top, inputs } };
}

export function collectRange(dir: string, spec: string): DiffResult {
  const top = repoTop(dir);
  if (top === null) return { ok: false, error: "--range must run inside a git repository." };
  const parts = spec.split("..");
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts[1].startsWith(".") || parts[0].endsWith(".")) {
    return { ok: false, error: `--range needs <from>..<to>, got "${spec}".` };
  }
  const [from, to] = parts as [string, string];
  for (const rev of [from, to]) {
    if (!git(top, ["rev-parse", "--verify", "-q", `${rev}^{commit}`]).ok) return { ok: false, error: `"${rev}" is not a commit in this repository.` };
  }
  const diff = git(top, ["diff", ...diffFlags, from, to, "--"]);
  if (!diff.ok) return { ok: false, error: `git diff failed: ${diff.stderr.trim()}` };
  const inputs = parseUnifiedDiff(diff.stdout).map((file) => toInput(file, isScanned(file.path) && !file.deleted ? blob(top, `${to}:${file.path}`) : null));
  return { ok: true, collected: { root: top, inputs } };
}
