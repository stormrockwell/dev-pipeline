import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Finding } from "./findings.ts";

export function findGitleaks(searchPath = process.env.PATH ?? ""): string | null {
  for (const dir of searchPath.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "gitleaks");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export type GitleaksTarget =
  | { mode: "staged" }
  | { mode: "range"; revs: string[] }
  | { mode: "stdin"; path: string; content: string };

export interface GitleaksOutcome {
  findings: Finding[];
  error: string | null;
}

// Gitleaks 8.19 replaced `protect` and `detect` with `git` and `stdin`.
function isModern(binary: string): boolean {
  const output = spawnSync(binary, ["version"], { encoding: "utf8" }).stdout ?? "";
  const version = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!version) return true;
  const [major, minor] = [Number(version[1]), Number(version[2])];
  return major > 8 || (major === 8 && minor >= 19);
}

function commandFor(target: GitleaksTarget, modern: boolean): string[] {
  switch (target.mode) {
    case "staged":
      return modern ? ["git", "--staged"] : ["protect", "--staged"];
    case "range":
      return [modern ? "git" : "detect", `--log-opts=${target.revs.join(" ")}`];
    case "stdin":
      return modern ? ["stdin"] : ["detect", "--pipe"];
  }
}

interface RawFinding {
  RuleID?: string;
  File?: string;
  StartLine?: number;
  Commit?: string;
}

export function runGitleaks(binary: string, cwd: string, target: GitleaksTarget): GitleaksOutcome {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-gitleaks-"));
  const report = join(dir, "report.json");
  try {
    const args = [
      ...commandFor(target, isModern(binary)),
      "--no-banner",
      "--redact",
      "--report-format",
      "json",
      "--report-path",
      report,
    ];
    const result = spawnSync(binary, args, {
      cwd,
      encoding: "utf8",
      input: target.mode === "stdin" ? target.content : undefined,
      maxBuffer: 512 * 1024 * 1024,
    });
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      const reason = result.error?.message ?? `exit ${result.status}`;
      return { findings: [], error: `gitleaks could not run (${reason}), using the built-in detectors only.` };
    }
    let raw: RawFinding[] = [];
    try {
      raw = JSON.parse(readFileSync(report, "utf8")) as RawFinding[];
    } catch {
      // No report means gitleaks found nothing to write.
    }
    const findings = raw.map((item): Finding => ({
      file: item.File || (target.mode === "stdin" ? target.path : ""),
      line: item.StartLine && item.StartLine > 0 ? item.StartLine : null,
      rule: `gitleaks/${item.RuleID ?? "unknown"}`,
      masked: "********",
      detail: null,
      commit: item.Commit ? item.Commit : null,
      detector: "gitleaks",
    }));
    return { findings, error: null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
