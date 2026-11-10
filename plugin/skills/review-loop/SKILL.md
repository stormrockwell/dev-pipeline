---
name: review-loop
description: Review each built task in rounds, simplifier first, then spec and standards, findings merged by precedence into one fix pass, fix rounds routed by the fix diff. Use when the build skill's checks pass, or when the developer asks to review a built task.
---

# Review loop

Review is step 6 of the change route. Its input is a work order whose tasks passed `pipeline task-check`. You dispatch, rule and route, and the reviewers and the implementer do the work. `pipeline review` decides which reviewers each round needs, so you follow its Dispatch lines.

Each Bash call is one plain `pipeline` or `git` command, with no `;`, `&&`, pipes or `$(...)`, because permission rules match whole commands.

## Each task

Take the tasks in the order the build ran them. Every command below names `.pipeline/work/<slug>/work-order.md --task <id>`.

1. **Start.** Run `pipeline review start .pipeline/work/<slug>/work-order.md --task <id>`. It prints the round, the order, one Dispatch line per reviewer with its package, why each one runs, and the gates it skipped. A `Done` line means the task's review is finished, so go to the next task.
2. **Simplifier.** When a Dispatch line names `dev-pipeline:simplifier`, dispatch it alone with the prompt `Read your review package at <package>, then review.` and wait for it. Then run `pipeline task-check --task <worktree>`, so its commits count. When the check fails, send the simplifier the output to fix or revert.
3. **Reviewers.** Dispatch every other Dispatch line in one message, so they run at once, with the same prompt and its own package. The Stop hook saves each reply's findings beside its package.
4. **Merge.** Run `pipeline review merge .pipeline/work/<slug>/work-order.md --task <id>`. When it says a reviewer's findings are missing, write that reply's json block to the path it names with Write and merge again. For each `Contest` line, read both findings: when they pull the same lines in opposite directions, run the overrule command it prints, which records the ruling. When both can be fixed together, leave them. A contest ends in an overrule or with both on the list.
5. **Fix.** With a `Fix list` line, dispatch `dev-pipeline:implementer` with two lines: `Read your fix list at <fix list>, then fix task <id>.` and the worktree path. When its reply disputes an item and the dispute holds, run `pipeline review dismiss .pipeline/work/<slug>/work-order.md --task <id> --finding <finding> --reason "<why>"`. Otherwise send the finding back with your reason. Then run `pipeline task-check --task <worktree>` and return to step 1 for the fix round.
6. **Cap.** When start says the task has had three rounds, stop and ask the developer whether the approach needs rethinking, with the open findings. Pass their answer as `--continue "<their reason>"` only when they say go on.

A security finding is never dismissed or parked, and a security reviewer that returns one outranks every other finding on its lines.

Done when every task's start prints `Done`, or a question is with the developer.

## Summary

Run `pipeline gate-record .pipeline/work/<slug>/work-order.md`, show its output in a code block, and add one line per waived finding or overrule from the ledger. Then stop, so the developer picks the next step.
