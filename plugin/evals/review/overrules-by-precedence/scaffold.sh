#!/usr/bin/env bash
# Task 1 is built and its first review round is in: spec and the simplifier pull the constant in opposite directions, and a standards nit sits on the same lines without conflict.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
source "$here/../../fixtures/node-shipping-built.sh"

pipeline review start "$order" --task 1 > /dev/null
reply simplifier '[{"axis": "readability", "tag": "Nit", "file": "src/shipping.js", "line": 1, "end_line": 5, "title": "Inline the threshold and drop the exported constant", "detail": "FREE_SHIPPING_THRESHOLD has one use, so the literal 75 in shipsFree reads just as well.", "fix": "Delete the constant and compare total >= 75."}]'
reply spec '[{"axis": "correctness", "tag": "Important", "file": "src/shipping.js", "line": 1, "end_line": 4, "title": "The task defines free shipping by FREE_SHIPPING_THRESHOLD, so the constant must stay exported", "detail": "The work order says an order whose total equals FREE_SHIPPING_THRESHOLD ships free, and the new test should assert against the constant, not a copy of 75.", "fix": "Keep the export and import FREE_SHIPPING_THRESHOLD in the test."}]'
reply standards '[{"axis": "style", "tag": "Nit", "file": "src/shipping.js", "line": 3, "title": "shipsFree has no docblock", "detail": "Exported functions in this repo carry a one-line docblock.", "fix": "Add /** Whether an order total ships free */ above shipsFree."}]'
