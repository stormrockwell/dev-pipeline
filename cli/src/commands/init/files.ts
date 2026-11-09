import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface PlannedFile {
  // Path relative to the target directory, with `/` separators.
  path: string;
  content: string;
}

export type WriteAction = "created" | "unchanged" | "kept" | "overwrote";

export interface WriteResult {
  path: string;
  action: WriteAction;
  reason?: string;
}

export interface WriteOptions {
  // Replaces a file that differs, which is the only way init overwrites anything.
  force?: boolean;
  // Reports what would happen and touches nothing.
  dryRun?: boolean;
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/**
 * Writes each file unless it already exists with different content. A file that differs is kept and
 * reported, so a developer's own config is never replaced silently, and --force is the only override.
 * A symlink is always kept, because writing through it could change a file outside the target.
 */
export function writeFiles(root: string, files: PlannedFile[], options: WriteOptions): WriteResult[] {
  const base = resolve(root);
  return files.map((file) => {
    const target = resolve(base, file.path);
    if (!inside(base, target)) throw new Error(`${file.path} points outside the target directory.`);

    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat === undefined) {
      if (!options.dryRun) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content);
      }
      return { path: file.path, action: "created" };
    }
    if (stat.isSymbolicLink()) return { path: file.path, action: "kept", reason: "it is a symlink" };
    if (!stat.isFile()) return { path: file.path, action: "kept", reason: "it is not a regular file" };
    if (readFileSync(target, "utf8") === file.content) return { path: file.path, action: "unchanged" };
    if (!options.force) return { path: file.path, action: "kept", reason: "it differs from what init would write" };
    if (!options.dryRun) writeFileSync(target, file.content);
    return { path: file.path, action: "overwrote" };
  });
}
