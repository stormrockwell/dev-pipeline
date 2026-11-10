#!/usr/bin/env bash
# Seeds the shop fixture, then puts this case's work order and branch in place.
# The harness resolves symlinks, so this is a real file that sources the shared fixture.
set -euo pipefail
. "$(dirname "$0")/../fixtures/shop.sh"
mkdir -p .pipeline/work/orders-export
cat > .pipeline/work/orders-export/work-order.md <<'MD'
---
title: Export orders as CSV
level: confirm
tasks:
  - id: 1
    title: Export button and handler
    files: [includes/orders-export.php, tests/test-orders-export.php]
    tier: T3
    zones: [authz, privacy]
    raised: exports customer order data, so authz and privacy before any signal matches
---

## Task 1: Export button and handler
An admin-post handler behind a button that streams every order as CSV.
MD
pipeline schedule .pipeline/work/orders-export/work-order.md > /dev/null
