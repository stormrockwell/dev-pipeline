import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs git in a directory and returns its stdout without the trailing newline, or throws with stderr
 *
 * Leading space stays, because `status --porcelain` puts a status column there.
 */
export function gitOut(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync("git", ["-c", "core.quotepath=off", ...args], { cwd, env, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  return (result.stdout ?? "").trimEnd();
}

/**
 * The tree id of the working tree as it stands, ignored files left out
 *
 * It stages into a throwaway index, so the real index and the files stay as they are. A test run
 * recorded with this id matches a later commit exactly when that commit holds the same files.
 */
export function workingTree(cwd: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "pipeline-tree-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
  try {
    gitOut(cwd, ["read-tree", "HEAD"], env);
    gitOut(cwd, ["add", "-A"], env);
    return gitOut(cwd, ["write-tree"], env);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Lines of a command's output, one entry per line, with empty output as none
 */
export function lines(output: string): string[] {
  return output === "" ? [] : output.split("\n");
}
