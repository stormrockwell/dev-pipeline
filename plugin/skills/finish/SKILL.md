---
name: finish
description: Open the draft PRs for a built and reviewed work order, with the changelog, version sync, a PR body from the docs agent and labels, after the developer says yes. Use when review passes, or when the developer asks to open the PR.
---

# Finish

Finish is steps 7 to 9 of the change route. Its input is the work order at `.pipeline/work/<slug>/work-order.md`, its `plan.json`, and the ledger, where every task shows `DONE`. You assemble and ask, the docs agent writes the prose, and scripts write everything that must not drift.

Each Bash call is one plain `pipeline`, `git` or `gh` command, with no `;`, `&&`, pipes or `$(...)`.

You open the PR as the side that built the work, and only after the developer says yes. Nobody in the pipeline merges.

## Each PR

Run `pipeline ledger .pipeline/work/<slug>/work-order.md` first. When a task is not `DONE`, build or review it before finishing. Take the PRs in the plan's order, a stacked PR after the one it stacks on. For each:

1. **Branch.** The PR's base is the branch of the PR it stacks on, or the default branch. Name its branch `<type>/<slug>`, with the type its commits mostly carry, and add `-<pr>` in lower case when the plan has more than one PR. Run `git worktree add -b <branch> .pipeline/work/<slug>/worktrees/pr-<pr> <task branch>` with the branch of the PR's first task from the ledger, then `git -C <path> merge --no-edit <task branch>` for each other task. A conflict stops here and goes to the developer. Done when the worktree holds every task's commits.
2. **Diff pass.** Run `pipeline schedule .pipeline/work/<slug>/work-order.md --range <base>..<branch>`. On exit 1, act as the work order skill's diff pass says, and finish only once it passes.
3. **Versions.** Run `pipeline version-sync changelog --dir <path> --range <base>..HEAD --write`. It writes only in a distributed project. When it adds entries, run `git -C <path> add CHANGELOG.md` and `git -C <path> commit -m "docs(changelog): <summary>"`. Then run `pipeline version-sync --dir <path>`. When it reports a mismatch, run `pipeline version-sync set <version> --dir <path>` with the version the main header or package.json holds, and commit that as `chore(version): sync version strings`. Done when it says the locations agree.
4. **Body.** Run `pipeline gate-record .pipeline/work/<slug>/work-order.md --pr <pr>`, so the docs agent reads a current record. Dispatch the `dev-pipeline:docs` agent with one line: `Write the PR body for PR <pr> of .pipeline/work/<slug>/work-order.md, branch <branch>, range <base>..<branch>.` Its reply is the draft. Write the reply to `.pipeline/work/<slug>/pr-<pr>-draft.md` exactly as it came, its `Title:` line included, then run `pipeline pr-body .pipeline/work/<slug>/work-order.md --pr <pr> --draft <draft path> --range <base>..<branch> --dir <path>`. It refreshes the record, so the run's spend so far is counted, and generates the Human review line, the Auditors list and the hidden record. When it fails on pr-check, send the docs agent its output and run it again, twice at most. When it refuses because a task is open or a gate failed, go back to build or review. Done when it prints `passes pr-check`.
5. **Ask.** Show the title, the labels and the body from `pr-body` in a code block, then ask once: `Push <branch> and open a draft PR against <base>? (y/N)`. Ask at every involvement level, because a push leaves the machine. Stop until the developer answers.
6. **Open.** On yes, run `git -C <path> push -u origin <branch>`. Then run `pipeline security-status .pipeline/work/<slug>/work-order.md --pr <pr> --dir <path>`, which prints one `gh api repos/<owner>/<repo>/statuses/<sha>` call, and run that call once. It posts the `pipeline/security` status for the pushed head only, under the same yes, so do not ask again. Then run `gh pr create --draft --base <base> --head <branch> --title "<title>" --body-file .pipeline/work/<slug>/pr-<pr>.md --label <label>` with one `--label` per label `pr-body` printed. When gh says a label is missing, open it without labels, because the `risk-gate` check applies them, and say `pipeline github commands --repo <owner/repo>` creates them. A no leaves the branch local and ends the step.

## Summary

Show one line per PR: its name, branch, URL or "kept local", and labels. Then stop, so the developer reviews the draft and marks it ready.
