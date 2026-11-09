import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { execProcess } from "./database.ts";
import type { Exec } from "./database.ts";

export type CloneMethod = "clone" | "copy" | "install" | "skipped";

export interface CloneResult {
  dir: string;
  method: CloneMethod;
}

export interface CloneStrategy {
  method: "clone" | "copy";
  file: string;
  args(from: string, to: string): string[];
}

export interface InstallPlan {
  file: string;
  args: string[];
  // The install only runs when the worktree carries this lockfile.
  lockfile: string;
}

/**
 * Copy on write first, because an APFS clone of a large tree is near instant and costs almost no disk.
 * A plain copy follows for filesystems without clones. Symlinks stay symlinks, which keeps node_modules/.bin intact.
 */
export function defaultStrategies(platform: NodeJS.Platform = process.platform): CloneStrategy[] {
  const copy: CloneStrategy = { method: "copy", file: "cp", args: (from, to) => ["-R", from, to] };
  if (platform === "darwin") return [{ method: "clone", file: "cp", args: (from, to) => ["-cR", from, to] }, copy];
  if (platform === "linux") {
    return [{ method: "clone", file: "cp", args: (from, to) => ["-R", "--reflink=always", from, to] }, copy];
  }
  return [copy];
}

export const defaultInstalls: Record<string, InstallPlan> = {
  node_modules: { file: "npm", args: ["ci", "--prefer-offline"], lockfile: "package-lock.json" },
  vendor: { file: "composer", args: ["install", "--prefer-dist", "--no-interaction"], lockfile: "composer.lock" },
};

export interface CloneOptions {
  source: string;
  dest: string;
  dirs: string[];
  timeoutMs: number;
  strategies?: CloneStrategy[];
  // Present only when installing is allowed as the last resort for a directory the source lacks.
  install?: Record<string, InstallPlan>;
  exec?: Exec;
}

async function failure(exec: Exec, file: string, args: string[], timeoutMs: number, cwd?: string): Promise<string | undefined> {
  const outcome = await exec(file, args, timeoutMs, cwd);
  if (outcome.spawnError) return `could not start ${file}: ${outcome.spawnError}`;
  if (outcome.timedOut) return `${file} timed out after ${Math.round(timeoutMs / 1000)}s`;
  if (outcome.exitCode !== 0) return (outcome.stderr || outcome.stdout).trim() || `${file} exited with ${outcome.exitCode}`;
  return undefined;
}

export async function cloneDependencies(options: CloneOptions): Promise<CloneResult[]> {
  const exec = options.exec ?? execProcess;
  const strategies = options.strategies ?? defaultStrategies();
  const results: CloneResult[] = [];

  for (const dir of options.dirs) {
    const from = join(options.source, dir);
    const to = join(options.dest, dir);

    if (existsSync(to)) {
      // A tracked directory already arrived with the checkout.
      results.push({ dir, method: "skipped" });
      continue;
    }

    if (!existsSync(from)) {
      const plan = options.install?.[dir];
      if (plan && existsSync(join(options.dest, plan.lockfile))) {
        const error = await failure(exec, plan.file, plan.args, options.timeoutMs, options.dest);
        if (error) throw new Error(`could not install ${dir}: ${error}`);
        results.push({ dir, method: "install" });
      } else {
        results.push({ dir, method: "skipped" });
      }
      continue;
    }

    mkdirSync(dirname(to), { recursive: true });
    let lastError = "no copy strategy is available";
    let done: CloneMethod | undefined;
    for (const strategy of strategies) {
      const error = await failure(exec, strategy.file, strategy.args(from, to), options.timeoutMs);
      if (!error) {
        done = strategy.method;
        break;
      }
      lastError = error;
      // A failed attempt can leave a partial tree that would turn the next copy into a nested one.
      rmSync(to, { recursive: true, force: true });
    }
    if (!done) throw new Error(`could not copy ${dir}: ${lastError}`);
    results.push({ dir, method: done });
  }
  return results;
}
