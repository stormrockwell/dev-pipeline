import { constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "../secrets/git.ts";

export interface Scope {
  /** A directory holding only the files the repo would commit. */
  dir: string;
  cleanup(): void;
}

/**
 * Copies the tracked files and the untracked files that are not ignored into a temp directory.
 * Gitleaks has no flag to scan a file list, and a copy keeps repo relative paths, so the
 * fingerprints in .gitleaksignore match. Symlinks would resolve to absolute paths and break them.
 * Returns undefined outside a git repo, and the caller then scans the whole directory.
 */
export function committableScope(dir: string): Scope | undefined {
  const listing = git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (!listing.ok) return undefined;

  const target = mkdtempSync(join(tmpdir(), "pipeline-check-scope-"));
  const cleanup = () => rmSync(target, { recursive: true, force: true });
  try {
    // A path can appear twice while a merge is unresolved, and a deleted or submodule entry is not a file.
    for (const path of new Set(listing.stdout.split("\0").filter(Boolean))) {
      const source = join(dir, path);
      if (!lstatSync(source, { throwIfNoEntry: false })?.isFile()) continue;
      const copy = join(target, path);
      mkdirSync(dirname(copy), { recursive: true });
      // Cloning is free on filesystems that support it, so large trees stay cheap.
      copyFileSync(source, copy, constants.COPYFILE_FICLONE);
    }
  } catch (error) {
    cleanup();
    throw error;
  }
  return { dir: target, cleanup };
}
