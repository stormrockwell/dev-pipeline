#!/usr/bin/env bash
# Task 1's first review round left one standards nit, and the implementer's fix adds the comment it asked for and passes its check.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
source "$here/../../fixtures/node-shipping-built.sh"

pipeline review start "$order" --task 1 > /dev/null
reply simplifier '[]'
reply spec '[]'
reply standards '[{"axis": "readability", "tag": "Nit", "file": "src/shipping.js", "line": 4, "title": "The inclusive threshold is easy to miss", "detail": "The task turns on an order of exactly 75, and >= alone does not say so.", "fix": "Say in a comment that an order at the threshold ships free."}]'
pipeline review merge "$order" --task 1 > /dev/null

cat > "$wt/src/shipping.js" <<'JS'
export const FREE_SHIPPING_THRESHOLD = 75;

export function shipsFree(total) {
  // An order of exactly the threshold ships free too.
  return total >= FREE_SHIPPING_THRESHOLD;
}
JS
git -C "$wt" commit -q -am "docs(shipping): note the inclusive threshold" -m "Co-Authored using AI"
pipeline tdd green --task "$wt" > /dev/null
printf 'Status: DONE\n\nAdded the comment standards-1.1 asked for.\n\n## Fixes\n- standards-1.1: fixed\n\nTask: %s\n' "$wt" > "$wt/.pipeline/task/report.md"
pipeline task-check --task "$wt" > /dev/null
