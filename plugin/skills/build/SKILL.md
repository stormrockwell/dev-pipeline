---
name: build
description: Build a confirmed work order, one implementer per task in its own worktree, each task checked against the report contract. Use after the developer replies "go" to a work order, or when the schedule prints `Confirm  skipped`.
---

# Build

Build is step 5 of the change route. Its input is the confirmed work order at `.pipeline/work/<slug>/work-order.md` and the `plan.json` beside it. You dispatch and check, and the implementer does all of the task work, because its turns cost less than yours.

Each Bash call is one plain `pipeline` or `git` command, with no `;`, `&&`, pipes or `$(...)`, because permission rules match whole commands.

## The ledger

Run `pipeline ledger .pipeline/work/<slug>/work-order.md` before the first task and whenever you resume. It lists each task's latest result and names the next task. A task it shows as `DONE` is built, so skip it: after compaction, trust the ledger and `git log` over what you remember. `pipeline task-check` writes each task's result there.

When you decide something on the developer's behalf, such as answering `NEEDS_CONTEXT` from the code or splitting a task, record it before you act: `pipeline ledger rule .pipeline/work/<slug>/work-order.md --task <id> --decided "<what>" --why "<why>" --cost "<what it costs if wrong>"`.

## Each task

Take the tasks in the order the schedule's `Order` line gives. Tasks it lists together in one wave may run at once, up to three, and every other task waits for the one it needs.

1. **Worktree.** Run `pipeline worktree create <slug>-<id> --path .pipeline/work/<slug>/worktrees/<id> --base <branch>`, where the base is the branch of the task this one needs, `wt/<slug>-<need>`, or the default branch when it needs none. The path keeps the worktree inside the ignored work folder, where a sandboxed session can write. Done when it prints the worktree path.
2. **Brief.** Run `pipeline brief .pipeline/work/<slug>/work-order.md <id> --worktree <path> --test "<command>"`. The test command is one plain command that runs the task's tests, from the repo's `package.json` or `composer.json` scripts, narrowed to the task's test file when the runner allows. `pipeline tdd` runs only that command, and only when `pipeline guard` allows it. Pass `--no-tdd "<reason>"` only when the developer declined TDD in the work order. Done when it prints the brief path.
3. **Dispatch.** Start the `dev-pipeline:implementer` agent with a prompt of two lines: `Read your brief at <brief path>, then build task <id>.` and the worktree path. The brief carries the whole task, so the prompt adds nothing else.
4. **Check.** Run `pipeline task-check --task <path>`. The implementer's reply is its report, and the Stop hook saves it to `.pipeline/task/report.md` in the worktree. When the check says no report exists, write the reply there with Write and run the check again. Then act on the reply's status:
   - `DONE` or `DONE_WITH_CONCERNS`, and the check passes: keep the concerns for the summary and go to the next task.
   - The check fails: send the implementer the check output and let it fix, twice at most. A third failure goes to the developer with the output.
   - `NEEDS_CONTEXT`: answer from the work order, the explorer's notes and the code when they hold the answer, and resume the implementer. Otherwise ask the developer, and pass on their answer.
   - `BLOCKED`: dispatch again on opus with the blocker, split the task by editing the work order and rerunning `pipeline schedule`, or ask the developer. Choose by what blocked it.

Done when every task's check passes or a question is with the developer.

## Summary

When every task's check passes, review the tasks with the `dev-pipeline:review-loop` skill, and keep each report's concerns for its summary.

Otherwise run `pipeline gate-record .pipeline/work/<slug>/work-order.md`, which prints a line per task with its gates and the run's cost. Show it in a code block with the question for the developer, then stop.
