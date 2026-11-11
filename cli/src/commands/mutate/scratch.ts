import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const RECORD_ROOT = ".pipeline";

/**
 * Splits a NUL separated git listing into paths
 */
function listing(cwd: string, args: string[]): string[] {
  const result = spawnSync("git", ["-c", "core.quotepath=off", ...args, "-z"], { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  return result.stdout.split("\0").filter(Boolean);
}

/**
 * Copies the files git would commit into a fresh temp directory and links the ignored ones back
 *
 * Ignored entries such as node_modules, vendor and an env file are linked instead of copied, because
 * they are large and a mutated run needs them to start. The task record folder stays behind, so a
 * mutated run cannot write into the task's evidence.
 */
export function makeScratch(worktree: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "pipeline-mutate-"));
  try {
    for (const path of listing(worktree, ["ls-files", "--cached", "--others", "--exclude-standard"])) {
      if (path === RECORD_ROOT || path.startsWith(`${RECORD_ROOT}/`)) continue;
      const from = join(worktree, path);
      const stat = lstatSync(from, { throwIfNoEntry: false });
      if (!stat || stat.isDirectory()) continue;
      const to = join(scratch, path);
      mkdirSync(dirname(to), { recursive: true });
      if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
      else cpSync(from, to, { preserveTimestamps: true });
    }
    for (const entry of listing(worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"])) {
      const path = entry.replace(/\/$/, "");
      if (path === RECORD_ROOT || path.startsWith(`${RECORD_ROOT}/`)) continue;
      const to = join(scratch, path);
      mkdirSync(dirname(to), { recursive: true });
      symlinkSync(join(worktree, path), to);
    }
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
  return scratch;
}
