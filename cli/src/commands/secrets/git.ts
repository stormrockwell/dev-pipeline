import { spawnSync } from "node:child_process";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function repoTop(cwd: string): string | null {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  return result.ok ? result.stdout.trim() : null;
}

/** Flags that pin the diff format against a user's git config. */
const diffFlags = [
  "-U0",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

export function stagedDiff(cwd: string): GitResult {
  return git(cwd, ["diff", "--cached", ...diffFlags]);
}

const COMMIT_MARK = "\u0001";

/**
 * Revision arguments for a push range. A new ref reports an all-zero or unknown old sha, and then the
 * range is every commit that no remote branch already holds.
 */
export function rangeRevs(cwd: string, spec: string): string[] | null {
  const parts = spec.split("..");
  if (parts.length !== 2 || parts[0]!.includes(".") || !parts[1]) return null;
  const [from, to] = parts as [string, string];
  const target = git(cwd, ["rev-parse", "--verify", "-q", `${to}^{commit}`]);
  if (!target.ok) return null;
  const known = from !== "" && !/^0+$/.test(from) && git(cwd, ["cat-file", "-e", `${from}^{commit}`]).ok;
  return known ? [`${from}..${to}`] : [to, "--not", "--remotes"];
}

export function rangeDiff(cwd: string, revs: string[]): GitResult {
  return git(cwd, [
    "log",
    "--reverse",
    `--format=${COMMIT_MARK}%H`,
    "--diff-merges=first-parent",
    "--no-show-signature",
    "-p",
    ...diffFlags,
    ...revs,
    "--",
  ]);
}

export function isIgnored(cwd: string, path: string): boolean {
  return git(cwd, ["check-ignore", "-q", "--no-index", path]).ok;
}

export { COMMIT_MARK };
