import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readRuns } from "../../task/evidence.ts";
import { gitOut, lines } from "../../task/git.ts";
import { ownsFile, readRecord, taskPaths, type TaskRecord } from "../../task/record.ts";

export type Status = "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_CONTEXT";

export interface CheckResult {
  record: TaskRecord;
  status: Status | null;
  problems: string[];
}

const bin = fileURLToPath(new URL("../../../bin/pipeline", import.meta.url));

// restates and commented-code misfire on docblock openers and prose, so the hook leaves them to the standards reviewer.
const BLOCKING_COMMENT_RULES = ["temporal", "reviewer", "todo-no-issue", "dash", "one-line-block"];

/**
 * The status from the report's Status line, allowing Markdown emphasis around the label
 */
export function reportStatus(report: string): Status | null {
  const match = /^[\s*_>-]*Status[*_]*:[*_]*\s*(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT)\b/m.exec(report);
  return match ? (match[1] as Status) : null;
}

/**
 * Problems with the task's test-first evidence, empty when a red run preceded a green run on HEAD's code
 */
function evidenceProblems(record: TaskRecord, headTree: string): string[] {
  const runs = readRuns(record.worktree);
  const green = runs.map((run) => run.phase === "green" && run.ok).lastIndexOf(true);
  const red = runs.slice(0, green === -1 ? runs.length : green).findLastIndex((run) => run.phase === "red" && run.ok);
  const problems: string[] = [];
  if (red === -1) {
    problems.push(
      green === -1
        ? `no red run, so write the failing test and run \`pipeline tdd red --task ${record.worktree}\``
        : `no red run before the green one, so the test never failed first. Make it fail, run \`pipeline tdd red --task ${record.worktree}\`, then green again`,
    );
  }
  if (green === -1) {
    problems.push(`no green run, so commit the passing code and run \`pipeline tdd green --task ${record.worktree}\``);
  } else if (runs[green]!.tree !== headTree) {
    problems.push(`the last green run tested other code than HEAD, so run \`pipeline tdd green --task ${record.worktree}\` again after your last commit`);
  } else if (red !== -1 && runs[red]!.tree === runs[green]!.tree) {
    problems.push("the red and green runs tested the same code, so the change never turned the test green");
  }
  return problems;
}

/**
 * Comment-lint findings on the task's commits, limited to the rules that hold on prose
 */
function commentProblems(record: TaskRecord): string[] {
  const result = spawnSync(process.execPath, [bin, "comment-lint", "--range", `${record.base}..HEAD`, "--json"], {
    cwd: record.worktree,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) return [];
  const findings = (JSON.parse(result.stdout || "[]") as { file: string; line: number; rule: string; text: string }[]).filter((finding) =>
    BLOCKING_COMMENT_RULES.includes(finding.rule),
  );
  if (findings.length === 0) return [];
  const listed = findings.map((finding) => `  ${finding.file}:${finding.line}  ${finding.rule}  ${finding.text}`);
  return [`fix the comments that break the writing rules, which say comment only why and keep comments evergreen:\n${listed.join("\n")}`];
}

/**
 * Checks a briefed task against the report contract
 *
 * A BLOCKED or NEEDS_CONTEXT report may stop at once, so a stuck implementer can hand its question
 * back. Every other status needs committed work inside the owned files, test-first evidence when the
 * tier calls for it, and comments that pass the writing rules.
 */
export function checkTask(worktree: string): CheckResult {
  const record = readRecord(worktree);
  const paths = taskPaths(worktree);
  const report = existsSync(paths.report) ? readFileSync(paths.report, "utf8") : null;
  const status = report === null ? null : reportStatus(report);
  const problems: string[] = [];

  if (report === null) problems.push(`write the report at ${paths.report}, starting with a Status line`);
  else if (status === null) problems.push("the report has no Status line, so start it with `Status: DONE`, `DONE_WITH_CONCERNS`, `BLOCKED` or `NEEDS_CONTEXT`");
  if (status === "BLOCKED" || status === "NEEDS_CONTEXT") return { record, status, problems };

  const dirty = lines(gitOut(worktree, ["status", "--porcelain", "--untracked-files=all"])).map((line) => line.slice(3));
  if (dirty.length > 0) problems.push(`commit or revert the uncommitted changes: ${dirty.join(", ")}`);

  const commits = Number(gitOut(worktree, ["rev-list", "--count", `${record.base}..HEAD`]));
  if (commits === 0) problems.push(`no commit since the brief, so commit the task's work on ${gitOut(worktree, ["branch", "--show-current"]) || "this branch"}`);

  const changed = lines(gitOut(worktree, ["diff", "--name-only", `${record.base}..HEAD`]));
  for (const file of changed) {
    if (ownsFile(record.files, file) || (report ?? "").includes(file)) continue;
    problems.push(`${file} is not an owned file, so revert it or name it under Unplanned in the report with the reason`);
  }

  if (record.tdd.required) problems.push(...evidenceProblems(record, gitOut(worktree, ["rev-parse", "HEAD^{tree}"])));
  if (commits > 0) problems.push(...commentProblems(record));
  return { record, status, problems };
}
