import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface RunOutcome {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started at all. */
  spawnError?: string;
}

const outputCap = 1_000_000;
const killGraceMs = 2_000;
const closeGraceMs = 1_000;

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Looks in the project's own directories first, so a pinned project version wins over a global one. */
export function resolveBinary(name: string, cwd: string, localDirs: string[]): string | undefined {
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = [...localDirs.map((dir) => join(cwd, dir)), ...pathDirs];
  return candidates.map((dir) => join(dir, name)).find(isExecutable);
}

/** Reports whether a short probe command succeeds, with output discarded so no pipe can hold it open. */
export function probe(file: string, args: string[], cwd: string): boolean {
  const result = spawnSync(file, args, { cwd, stdio: "ignore", timeout: 10_000 });
  return result.status === 0;
}

/**
 * Runs a command with a hard timeout. The tool gets its own process group, so a timeout
 * also stops the children it started, which would otherwise keep the pipes open and hang the run.
 */
export function run(file: string, args: string[], cwd: string, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    const child = spawn(file, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ exitCode, timedOut, stdout, stderr, spawnError });
    };

    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        // The group is already gone.
      }
    };

    const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stream === "stdout" && stdout.length < outputCap) stdout += text;
      if (stream === "stderr" && stderr.length < outputCap) stderr += text;
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));

    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(timedOut ? null : code));
    child.on("exit", (code) => {
      // A grandchild can keep the pipes open after the tool itself exits.
      timers.push(setTimeout(() => finish(timedOut ? null : code), closeGraceMs));
    });

    timers.push(
      setTimeout(() => {
        timedOut = true;
        signalGroup("SIGTERM");
        timers.push(
          setTimeout(() => {
            signalGroup("SIGKILL");
            timers.push(setTimeout(() => finish(null), closeGraceMs));
          }, killGraceMs),
        );
      }, timeoutMs),
    );
  });
}
