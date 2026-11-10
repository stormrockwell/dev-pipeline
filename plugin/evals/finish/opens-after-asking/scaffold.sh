#!/usr/bin/env bash
# A Node shop whose one task is built and reviewed, with one gate skipped, so the run starts at finish.
set -euo pipefail
fixtures="$(dirname "$(realpath "${BASH_SOURCE[0]}")")/../../fixtures"
source "$fixtures/node-shipping.sh"

slug=free-shipping
fix_file=src/shipping.js
fix_from='total > FREE_SHIPPING_THRESHOLD'
fix_to='total >= FREE_SHIPPING_THRESHOLD'
test_file=test/shipping.test.js
test_body='
test("an order of exactly the threshold ships free", () => {
  assert.equal(shipsFree(75), true);
});'
source "$fixtures/built-task.sh"

for gate in simplifier standards spec; do
  pipeline ledger gate "$order" --task 1 --gate "$gate" --result pass > /dev/null
done
pipeline ledger gate "$order" --task 1 --gate "quick security review" --result skip --note "security reviewer not built yet" > /dev/null
