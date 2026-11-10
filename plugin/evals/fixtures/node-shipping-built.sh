#!/usr/bin/env bash
# Seeds the Node shop with task 1 already built in its worktree: red then green evidence, a commit and a passing check, so a run starts at review.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
source "$here/node-shipping.sh"

pipeline() { node "$HOME/.pipeline-cli/bin/pipeline" "$@"; }
order=.pipeline/work/free-shipping/work-order.md
wt="$PWD/.pipeline/work/free-shipping/worktrees/1"

git worktree add -q -b wt/free-shipping-1 "$wt"
pipeline brief "$order" 1 --worktree "$wt" --test "node --test" > /dev/null

cat >> "$wt/test/shipping.test.js" <<'JS'

test("an order of exactly the threshold ships free", () => {
  assert.equal(shipsFree(75), true);
});
JS
pipeline tdd red --task "$wt" > /dev/null

cat > "$wt/src/shipping.js" <<'JS'
export const FREE_SHIPPING_THRESHOLD = 75;

export function shipsFree(total) {
  return total >= FREE_SHIPPING_THRESHOLD;
}
JS
git -C "$wt" add -A
git -C "$wt" commit -q -m "fix(shipping): ship free at exactly the threshold" -m "Co-Authored using AI"
pipeline tdd green --task "$wt" > /dev/null

printf 'Status: DONE\n\nAn order of exactly 75 ships free, tested through shipsFree(75).\n\nTask: %s\n' "$wt" > "$wt/.pipeline/task/report.md"
pipeline task-check --task "$wt" > /dev/null

# Replies a reviewer of the current round, the way its Stop hook saves them.
reply() {
  local reviewer="$1" findings="$2" round="${3:-1}"
  local package="$PWD/.pipeline/work/free-shipping/review/task-1/round-$round/package-$reviewer.md"
  local message
  message="$(printf 'Reviewed.\n\n```json\n{"findings": %s}\n```\n\nPackage: %s' "$findings" "$package")"
  node -e 'process.stdout.write(JSON.stringify({ hook_event_name: "SubagentStop", last_assistant_message: process.argv[1] }))' "$message" | pipeline review save --hook
}
