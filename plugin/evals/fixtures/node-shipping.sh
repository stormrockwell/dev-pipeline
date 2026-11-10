#!/usr/bin/env bash
# Seeds a Node shop with a confirmed one-task work order and its plan, so a run starts at the build step.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
source "$here/pipeline-cli.sh"

git init -q -b main
git config user.email dana@example.com
git config user.name "Dana Dev"

mkdir -p src test .pipeline/work/free-shipping
printf 'node_modules/\n.pipeline/work/\n' > .gitignore

cat > package.json <<'JSON'
{
  "name": "shop-demo",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
JSON

cat > src/shipping.js <<'JS'
export const FREE_SHIPPING_THRESHOLD = 75;

export function shipsFree(total) {
  return total > FREE_SHIPPING_THRESHOLD;
}
JS

cat > test/shipping.test.js <<'JS'
import { test } from "node:test";
import assert from "node:assert/strict";
import { shipsFree } from "../src/shipping.js";

test("an order over the threshold ships free", () => {
  assert.equal(shipsFree(100), true);
});

test("an order under the threshold pays shipping", () => {
  assert.equal(shipsFree(20), false);
});
JS

git add .
git commit -q -m "feat(shipping): add free shipping"

cat > .pipeline/work/free-shipping/work-order.md <<'MD'
---
title: Let an order of exactly the threshold ship free
level: confirm
tasks:
  - id: 1
    title: Free shipping at the threshold
    files: [src/shipping.js, test/shipping.test.js]
    tier: T2
    zones: []
---

## Task 1: Free shipping at the threshold
An order whose total equals FREE_SHIPPING_THRESHOLD ships free. Prove it through shipsFree(total) with a test for a total of exactly 75, beside the existing tests in test/shipping.test.js.
MD

node "$HOME/.pipeline-cli/bin/pipeline" schedule .pipeline/work/free-shipping/work-order.md > /dev/null
