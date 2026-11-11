import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { TaskRecord } from "../task/record.ts";
import { taskPaths } from "../task/record.ts";
import { gitOut, lines } from "../task/git.ts";
import type { Finding, Reviewer } from "./findings.ts";
import { REVIEWER_AXES } from "./findings.ts";
import type { Candidate } from "./security.ts";
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

const JOBS: Record<Exclude<Reviewer, "security">, string[]> = {
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
  accessibility: [
    "Review the markup, CSS and front-end code in the diff for what axe cannot see: keyboard order, focus management in dynamic UI, and alt text that is present but meaningless. Follow your instructions for how.",
  ],
};

/**
 * The package one reviewer reads: the diff to review, the task, its open findings and the reply contract
 */
export function renderPackage(reviewer: Exclude<Reviewer, "security">, round: Round, record: TaskRecord, section: string, guides: string[], open: Finding[]): string {
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

// Each hunter of a full review starts somewhere else, because one pass finds about half of what repeated passes do.
const LENSES = [
  "access control: who can reach each changed entry point, and what checks the caller before it acts",
  "input and output: what untrusted data reaches a query, a file, a command, a redirect, a remote call or the page",
  "data and configuration: what the change stores, logs, exposes or loads from outside, and which settings it loosens",
];

const LIGHT = [
  "**Secrets and keys**: API keys, tokens, passwords, private keys or connection strings in code, config, docs or fixtures.",
  "**External URLs and loads**: new scripts, styles, fonts, iframes, images or form targets from another origin.",
  "**Tracking**: analytics, pixels, beacons or third-party embeds that send visitor data out.",
  "**Exposed data**: personal data, internal paths or debug output that reaches a page, a log or a response.",
  "**Configuration values**: debug flags, permissive CORS, disabled checks or default credentials.",
];

/**
 * The facts block at the top of a security package
 */
function factsBlock(facts: string[][]): string[] {
  const width = Math.max(...facts.map(([label]) => label!.length)) + 2;
  return ["```", ...facts.map(([label, value]) => `${label!.padEnd(width)}${value}`), "```"];
}

/**
 * The package one security hunter reads: the diff at the tier's depth, the task, the open security findings and the reply contract
 */
export function renderHunterPackage(number: number, round: Round, record: TaskRecord, section: string, open: Finding[]): string {
  const security = round.security!;
  const dir = join(dirname(record.workOrder), "review", `task-${round.task}`, `round-${round.round}`);
  const paths = roundPaths(dir);
  const whole = security.from !== round.from;
  const facts = [
    ["Worktree", record.worktree],
    ["Round", `${round.round}, ${round.scope === "full" ? "full, so hunt the whole diff" : whole ? "a fix round on zone code, so hunt the whole task diff" : "a fix round, so hunt the fix diff"}`],
    ["Depth", `${security.depth}${security.hunters > 1 ? `, hunter ${number} of ${security.hunters}` : ""}`],
    ["Diff", `git -C ${record.worktree} diff ${security.from}..HEAD`],
    ["Owned files", record.files.join(", ")],
    ["Tier", record.zones.length > 0 ? `${record.tier}, zones ${record.zones.join(", ")}` : record.tier],
    ...(round.zoneFiles.length > 0 ? [["Zone files", round.zoneFiles.join(", ")]] : []),
    ["Why you", round.reasons.security ?? "the task's tier calls for a security review"],
  ];
  const job =
    security.depth === "light"
      ? ["This is a light pass. Check every changed line, docs and copy included, against this list, and report only what crosses a trust boundary:", "", ...LIGHT.map((item) => `- ${item}`)]
      : [
          "- Hunt the diff for vulnerabilities by the rules in your instructions. Read the code each changed line reaches, and the callers of each changed function.",
          ...(security.hunters > 1 ? [`- Start with ${LENSES[(number - 1) % LENSES.length]}. Then cover the rest of the diff, because the other hunters work alone.`] : []),
        ];
  return [
    `# Security hunt: task ${round.task}, round ${round.round}${security.hunters > 1 ? `, hunter ${number}` : ""}`,
    "",
    ...factsBlock(facts),
    "",
    "## Your job",
    "",
    ...job,
    ...(security.php ? ["", `The diff holds PHP, so read the WordPress companion at ${paths.companion} before you hunt.`] : []),
    "",
    "## The task",
    "",
    section.trim(),
    "",
    ...(open.length > 0
      ? [
          "## Open security findings",
          "",
          "Check each against the code at HEAD. Report one that still holds again with its id, and leave out one the fix closed.",
          "",
          "```json",
          JSON.stringify({ findings: open.map((finding) => ({ id: finding.id, file: finding.file, line: finding.line, end_line: finding.end_line, title: finding.title, boundary: finding.boundary, result: finding.result, severity: finding.severity, fix: finding.fix, tests: finding.tests })) }, null, 2),
          "```",
          "",
        ]
      : []),
    "## Reply",
    "",
    "End your reply with one ```json block holding `findings`, `needs_validation` and `boundaries`, then this line:",
    "",
    `Package: ${paths.package(`security-hunter-${number}`)}`,
    "",
  ].join("\n");
}

/**
 * The package one security verifier reads: the candidates to disprove, with nothing that says who found them
 */
export function renderVerifierPackage(number: number, round: Round, record: TaskRecord, section: string, candidates: Candidate[]): string {
  const security = round.security!;
  const paths = roundPaths(join(dirname(record.workOrder), "review", `task-${round.task}`, `round-${round.round}`));
  const facts = [
    ["Worktree", record.worktree],
    ["Diff", `git -C ${record.worktree} diff ${security.from}..HEAD`],
    ["Depth", `${security.depth}${security.verifiers > 1 ? `, verifier ${number} of ${security.verifiers}, and a majority decides` : ""}`],
    ["Candidates", String(candidates.length)],
  ];
  const claims = candidates.map((candidate) => ({
    id: candidate.id,
    file: candidate.file,
    line: candidate.line,
    end_line: candidate.end_line,
    title: candidate.title,
    boundary: candidate.boundary,
    result: candidate.result,
    severity: candidate.severity,
    detail: candidate.detail,
    fix: candidate.fix,
  }));
  return [
    `# Security verification: task ${round.task}, round ${round.round}${security.verifiers > 1 ? `, verifier ${number}` : ""}`,
    "",
    ...factsBlock(facts),
    "",
    "## Your job",
    "",
    "- Each candidate below is a claim from another agent. Try to disprove it against the code at HEAD, by the rules in your instructions, and give one verdict per candidate.",
    ...(security.php ? [`- The diff holds PHP, so read the WordPress companion at ${paths.companion} first.`] : []),
    "",
    "## The task",
    "",
    section.trim(),
    "",
    "## Candidates",
    "",
    "```json",
    JSON.stringify({ candidates: claims }, null, 2),
    "```",
    "",
    "## Reply",
    "",
    "End your reply with the verdicts as one ```json block, then this line:",
    "",
    `Package: ${paths.package(`security-verifier-${number}`)}`,
    "",
  ].join("\n");
}
