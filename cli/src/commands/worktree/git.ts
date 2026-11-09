import { run } from "../check/exec.ts";

export interface GitOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Runs git with a hard timeout. A hung git is an error, never a silent wait. */
export async function git(cwd: string, args: string[], timeoutMs: number): Promise<GitOutcome> {
  const outcome = await run("git", args, cwd, timeoutMs);
  if (outcome.spawnError) throw new Error(`could not start git: ${outcome.spawnError}`);
  if (outcome.timedOut) throw new Error(`git ${args.join(" ")} timed out after ${Math.round(timeoutMs / 1000)}s.`);
  return { ok: outcome.exitCode === 0, stdout: outcome.stdout, stderr: outcome.stderr };
}

export async function gitOk(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  const outcome = await git(cwd, args, timeoutMs);
  if (!outcome.ok) throw new Error(`git ${args.join(" ")} failed: ${(outcome.stderr || outcome.stdout).trim()}`);
  return outcome.stdout.trim();
}
