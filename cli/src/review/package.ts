import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { TaskRecord } from "../task/record.ts";
import { taskPaths } from "../task/record.ts";
import { gitOut, lines } from "../task/git.ts";
import type { Finding, Reviewer } from "./findings.ts";
import { REVIEWER_AXES } from "./findings.ts";
import { roundPaths, type Round } from "./state.ts";

/**
 * The REVIEW.md files that govern a diff: one in each changed file's folder or any folder above it
 */
export function reviewGuides(worktree: string, from: string): string[] {
  const found = new Set<string>();
  for (const file of lines(gitOut(worktree, ["diff", "--name-only", "--no-renames", from, "HEAD"]))) {
    let dir = dirname(join(worktree, file));
    while (dir.startsWith(worktree)) {
      const guide = join(dir, "REVIEW.md");
      if (existsSync(guide)) found.add(relative(worktree, guide));
      if (dir === worktree) break;
      dir = dirname(dir);
    }
  }
  return [...found].sort();
}

const JOBS: Record<Reviewer, string[]> = {
  spec: [
    "Check the diff against the task section below: missing requirements, behavior nobody asked for, and requirements read wrong.",
    "Judge the tests against the test checklist in your instructions, and check the evidence log shows each test failing before the code and passing after.",
  ],
  standards: [
    "Run `pipeline review files --task {worktree} --from {from}` for the files to review and the rules for each, then review every listed file against its rules, the repo's standards and the comment standard.",
  ],
  simplifier: [
    "Simplify the code in the diff and the code it directly calls, by your four questions. Commit each simplification with `refactor(<scope>): <subject>`, then run `pipeline tdd green --task {worktree}` on the last commit, and revert any change that turns it red.",
    "In the zone files listed below, change nothing: report each simplification as a finding instead, for a person to review.",
  ],
};

/**
 * The package one reviewer reads: the diff to review, the task, its open findings and the reply contract
 */
export function renderPackage(reviewer: Reviewer, round: Round, record: TaskRecord, section: string, guides: string[], open: Finding[]): string {
  const paths = roundPaths(join(dirname(record.workOrder), "review", `task-${round.task}`, `round-${round.round}`));
  const fill = (text: string) => text.replaceAll("{worktree}", record.worktree).replaceAll("{from}", round.from);
  const mine = open.filter((finding) => finding.reviewer === reviewer);
  const facts = [
    ["Worktree", record.worktree],
    ["Round", `${round.round}, ${round.scope === "full" ? "full, so review the whole diff" : "a fix round, so review only the fix diff"}`],
    ["Diff", `git -C ${record.worktree} diff ${round.from}..HEAD`],
    ...(round.scope === "fix" ? [["Whole task", `git -C ${record.worktree} diff ${round.base}..HEAD, for context only`]] : []),
    ["Owned files", record.files.join(", ")],
    ["Tier", record.zones.length > 0 ? `${record.tier}, zones ${record.zones.join(", ")}` : record.tier],
    ["Your axes", REVIEWER_AXES[reviewer].join(", ")],
    ["Report", `${taskPaths(record.worktree).report}, claims to verify`],
    ["Evidence", taskPaths(record.worktree).evidence],
    ["Why you", round.reasons[reviewer] ?? "the task's tier calls for you"],
  ];
  const width = Math.max(...facts.map(([label]) => label!.length)) + 2;
  return [
    `# Review package: ${reviewer}, task ${round.task}, round ${round.round}`,
    "",
    "```",
    ...facts.map(([label, value]) => `${label!.padEnd(width)}${value}`),
    "```",
    "",
    "## Your job",
    "",
    ...JOBS[reviewer].map((line) => `- ${fill(line)}`),
    ...(reviewer === "simplifier" && round.zoneFiles.length > 0 ? ["", "Zone files, propose only:", "", ...round.zoneFiles.map((file) => `- ${file}`)] : []),
    ...(guides.length > 0 ? ["", "Read these REVIEW.md files first. Each one is the standard for its folder:", "", ...guides.map((guide) => `- ${guide}`)] : []),
    "",
    "## The task",
    "",
    section.trim(),
    "",
    ...(mine.length > 0
      ? [
          "## Your open findings",
          "",
          "Check each against the fix. Report one that is still open again with its id, and leave out one the fix addressed.",
          "",
          "```json",
          JSON.stringify({ findings: mine.map((finding) => Object.fromEntries(Object.entries(finding).filter(([key]) => key !== "reviewer"))) }, null, 2),
          "```",
          "",
        ]
      : []),
    "## Reply",
    "",
    "End your reply with the findings as one ```json block, then this line:",
    "",
    `Package: ${paths.package(reviewer)}`,
    "",
  ].join("\n");
}
