import type { TaskRecord } from "../../task/record.ts";
import { taskPaths } from "../../task/record.ts";
import type { Task } from "../schedule/work-order.ts";

/**
 * The brief an implementer reads first, and the only task text it gets
 */
export function renderBrief(record: TaskRecord, task: Task, section: string, orderTitle: string): string {
  const paths = taskPaths(record.worktree);
  const test = record.test ?? "<the repo's test command>";
  // A subagent's shell can start in the main checkout, so every command names the worktree.
  const at = `--task ${record.worktree}`;
  const body = section.replace(/^#+\s+Task\s+\S+?:?\s*.*\n?/, "").trim();
  const facts = [
    ["Work order", orderTitle],
    ["Worktree", record.worktree],
    ["Owned files", record.files.join(", ")],
    ["Tier", record.zones.length > 0 ? `${record.tier}, zones ${record.zones.join(", ")}` : record.tier],
    ["Gates", record.gates.join(", ")],
    ...(task.needs.length > 0 ? [["Builds on", `task ${task.needs.join(", ")}, already in your base`]] : []),
    ...((task.interfaces ?? []).length > 0 ? [["Interfaces", task.interfaces!.join(", ")]] : []),
    ...((task.state ?? []).length > 0 ? [["Shared state", task.state!.join(", ")]] : []),
    ...(record.tdd.required ? [] : [["TDD", `not required, because ${record.tdd.reason}`]]),
  ];
  const width = Math.max(...facts.map(([label]) => label!.length)) + 2;

  const tdd = record.tdd.required
    ? [
        "## Test first",
        "",
        `1. Write the test that proves the task, then run \`pipeline tdd red ${at} -- ${test}\`. It runs the command in the worktree, records the run, and refuses a command that passes or never ran. Read the failure and check it fails for the reason you expect.`,
        "2. Write the code that makes it pass, run the focused test while you work, and commit.",
        `3. Run \`pipeline tdd green ${at} -- ${test}\` on the committed code. A green run on code you change afterwards does not count, so run it again after the last commit.`,
        "",
      ]
    : [];

  return [
    `# Task ${record.id}: ${record.title}`,
    "",
    "```",
    ...facts.map(([label, value]) => `${label!.padEnd(width)}${value}`),
    "```",
    "",
    "## The task",
    "",
    body,
    "",
    ...tdd,
    "## Rules",
    "",
    "- Work only in the worktree above, and change only the owned files. A file you must touch outside them goes in the report under Unplanned, with the reason.",
    "- Comment only why, and keep comments evergreen.",
    `- Run git as \`git -C ${record.worktree} <command>\`, so it acts on the worktree whatever directory the shell is in.`,
    "- Commit on this branch with `type(scope): subject`. Never push, merge or open a PR.",
    "- Run each command as its own Bash call, and edit files with Edit and Write.",
    "",
    "## Report",
    "",
    `Write ${paths.report}. Its first line is \`Status: DONE\`, \`DONE_WITH_CONCERNS\`, \`BLOCKED\` or \`NEEDS_CONTEXT\`. Then: what you built, the tests and their result, the files you changed, any Unplanned files, and your concerns.`,
    "",
    `Run \`pipeline task-check ${at}\` before you finish. The Stop hook runs the same check and sends you back with what it found.`,
    "",
    "End your reply with at most ten lines: the status, your commits as short sha and subject, one line on the tests, any concern, and last this line:",
    "",
    `Task: ${record.worktree}`,
    "",
  ].join("\n");
}
