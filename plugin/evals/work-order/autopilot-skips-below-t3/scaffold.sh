#!/usr/bin/env bash
# Seeds the shop fixture.
# The harness resolves symlinks, so this is a real file that sources the shared fixture.
set -euo pipefail
. "$(dirname "$0")/../fixtures/shop.sh"
