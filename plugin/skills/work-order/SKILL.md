---
name: work-order
description: Shape a change into a work order of tasks and owned files, classify each task, split PRs and confirm before editing code. Use on the change route after exploring, when the developer edits a work order or asks to lower a tier, and before a PR opens to check the diff against the plan.
---

# Work order

The work order is steps 2 to 4 of the change route: shape, classify, confirm. Code waits until the developer replies "go", or until `pipeline schedule` prints `Confirm  skipped`.

Each Bash call is one plain `pipeline` or `git` command, with no `;`, `&&`, pipes, `$(...)` or `echo`, because permission rules match whole commands. Explore with Read, Glob and Grep, and let Write create folders.

## 1. Shape

Draft tasks from the request and what you explored. Each task owns the files it creates or edits, tests included, and a file has one owner unless one task `needs` the other.

Paperwork scales with the work:

- **One task.** The work order is the plan: one task with `id`, `title`, `files`, `tier` and `zones`. Leave out `needs`, `interfaces` and `state`, and write no other files.
- **Several tasks.** Add the task graph to the same file: `needs` lists the tasks that must land first, `interfaces` names the functions, hooks, routes or types a task provides or calls, and `state` names shared options, tables or caches. Tasks that share an interface or state run serially.
- **Multi-session work only.** Add `spec.md` and one `tickets/<id>.md` per task beside the work order.

Zone work, such as auth, permissions, nonces, request input, SQL, uploads, secrets, personal data or destructive data changes, goes in its own task, and that task carries all of the component's security logic. When the logic is scattered, the first task is a prefactor that consolidates it into one module. A task that cannot stand alone, such as a one-line hook registration, sets `joins: <id>` to ride in that task's PR.

Write `.pipeline/work/<slug>/work-order.md`. The folder stays git-ignored: when `git check-ignore -q .pipeline/work/<slug>/work-order.md` fails, add `.pipeline/work/` to `.git/info/exclude`.

```markdown
---
title: Add a CSV export to the orders page
level: confirm
tasks:
  - id: 1
    title: CSV formatter
    files: [includes/orders-csv.php, tests/test-orders-csv.php]
    tier: T2
    zones: []
    needs: []
    interfaces: [shop_demo_orders_csv()]
    state: []
  - id: 2
    title: Export handler with capability and nonce checks
    files: [includes/orders-export.php, tests/test-orders-export.php]
    tier: T3
    zones: [authz, csrf]
    raised: exports order data, so authz even before a signal matches
    needs: [1]
    interfaces: [shop_demo_orders_csv(), admin-post shop_demo_export]
    state: []
---

## Task 1: CSV formatter
Goal, the interface contract, and the tests that prove it, in a few lines per task.
```

## 2. Classify

1. For each task run `pipeline classify --json <owned files>` and copy its `tier` and `zones` into the task.
2. Raise a tier or add a zone when the request means more risk than the files show, such as an export that exposes data, and give the reason in `raised`. Set `uncertain: true` when you cannot tell.
3. Run `pipeline schedule .pipeline/work/<slug>/work-order.md`. It sets tiers, gates, the PR split, the order and whether to confirm. Exit 2 means the file is invalid: fix it and rerun.

## 3. Lowering belongs to a peer

Anyone can raise a tier or add a zone. Only a peer reviewer lowers a tier or removes a zone, never the author and never you. When the developer asks to lower one, such as "it is just a button", leave the file as it is and say once that a peer reviewer has to sign the lowering. Write `lowered_by` and `lowered_reason` only with words a named peer gave, and every screen prints that lowering. Editing `tier` down changes nothing, because the schedule holds the rules tier and the tiers in its last `plan.json`. Keep task ids stable once scheduled.

## 4. Confirm

Show the `pipeline schedule` output in a code block as the whole confirmation. Add at most three lines below it, and only for decisions the output lacks: a review a signal calls for (performance on queries or loops over data, accessibility on markup), the scale assumption, or a TDD question in an existing codebase with no suite (`TDD  no suite yet; recommended for task 2. Use TDD? (Y/n)`). Owned files, interfaces and reasons stay in the file. Then stop until the developer replies.

Involvement level, written as `level`: the request, else `involvement` in `.pipeline/profile.yml`, else `confirm`. A repo floor in the profile wins over a lighter level.

- `guide`: confirm the work order, then confirm before each later step, with one line on why each gate exists.
- `confirm`: confirm the work order once, then run to the PR.
- `autopilot`: when the schedule prints `Confirm  skipped`, show the screen and start building.

An edit such as "move task 3 to PR A" changes the file, and you rerun the schedule and show the new screen.

## 5. Diff pass

Before a PR opens, run `pipeline schedule .pipeline/work/<slug>/work-order.md --range <base>..HEAD`. Exit 1 means the diff touched a file no task owns, or raised a task. Add each `Unplanned` file to the task that wrote it, rerun, and tell the developer in one line which task was raised and which PR it moved to. A task with zone code always moves into a zone PR.
