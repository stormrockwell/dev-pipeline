#!/usr/bin/env bash
# Sourced after a fixture that seeds a scheduled one-task work order. It builds task 1 the way the
# build step would, red then green in its worktree with a passing check, so a run starts at finish.
# The caller sets slug, fix_file, fix_from, fix_to, test_file, test_body and, for a repo with no
# suite, no_tdd with the reason.
set -euo pipefail
pipeline() { node "$HOME/.pipeline-cli/bin/pipeline" "$@"; }

order=".pipeline/work/$slug/work-order.md"
wt=".pipeline/work/$slug/worktrees/1"
git worktree add -q -b "wt/$slug-1" "$wt" main
wt="$(cd "$wt" && pwd)"

if [ -n "${no_tdd:-}" ]; then
  pipeline brief "$order" 1 --worktree "$wt" --no-tdd "$no_tdd" > /dev/null
else
  pipeline brief "$order" 1 --worktree "$wt" --test "node --test" > /dev/null
  printf '%s\n' "$test_body" >> "$wt/$test_file"
  pipeline tdd red --task "$wt" > /dev/null
fi

# The strings travel in the environment, so perl reads them literally.
FROM="$fix_from" TO="$fix_to" perl -0pi -e 's/\Q$ENV{FROM}\E/$ENV{TO}/' "$wt/$fix_file"
git -C "$wt" add -A
git -C "$wt" commit -q -m "fix(shipping): ship free at exactly the threshold"
[ -n "${no_tdd:-}" ] || pipeline tdd green --task "$wt" > /dev/null

printf 'Status: DONE\n\nAn order of exactly the threshold ships free.\n\nTask: %s\n' "$wt" > "$wt/.pipeline/task/report.md"
pipeline task-check --task "$wt" > /dev/null
