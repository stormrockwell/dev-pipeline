#!/usr/bin/env bash
# Seeds a repo from a case's sources/base folder, then commits its sources/task folder as built task 1
# in review round 1 with the simplifier, spec, standards and security replies saved, so a run dispatches
# only the performance reviewer. The caller sets sources, title and description.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
source "$here/../../fixtures/pipeline-cli.sh"
pipeline() { node "$HOME/.pipeline-cli/bin/pipeline" "$@"; }

git init -q -b main
git config user.email dana@example.com
git config user.name "Dana Dev"
mkdir -p .pipeline/work/feature
printf '.pipeline/work/\nnode_modules/\n' > .gitignore

cp -R "$sources/base/." .
git add .
git commit -q -m "feat: base"

files="$(cd "$sources/task" && find . -type f | sed 's|^\./||' | sort | paste -sd, - | sed 's/,/, /g')"
cat > .pipeline/work/feature/work-order.md <<MD
---
title: $title
level: confirm
tasks:
  - id: 1
    title: $title
    files: [$files]
    tier: T2
    zones: []
---

## Task 1: $title
$description The project has no test suite, and the developer declined one for this change.
MD
pipeline schedule .pipeline/work/feature/work-order.md > /dev/null

order=.pipeline/work/feature/work-order.md
wt="$PWD/.pipeline/work/feature/worktrees/1"
git worktree add -q -b wt/feature-1 "$wt"
pipeline brief "$order" 1 --worktree "$wt" --no-tdd "the project has no test suite, and the developer declined one" > /dev/null

cp -R "$sources/task/." "$wt/"
git -C "$wt" add -A
git -C "$wt" commit -q -m "feat: $title" -m "Co-Authored using AI"

printf 'Status: DONE\n\n%s\n\nTask: %s\n' "$description" "$wt" > "$wt/.pipeline/task/report.md"
pipeline task-check --task "$wt" > /dev/null

pipeline review start "$order" --task 1 > /dev/null
for reviewer in simplifier spec standards security-hunter-1; do
  package="$PWD/.pipeline/work/feature/review/task-1/round-1/package-$reviewer.md"
  message="$(printf 'Reviewed.\n\n```json\n{"findings": []}\n```\n\nPackage: %s' "$package")"
  node -e 'process.stdout.write(JSON.stringify({ hook_event_name: "SubagentStop", last_assistant_message: process.argv[1] }))' "$message" | pipeline review save --hook
done
