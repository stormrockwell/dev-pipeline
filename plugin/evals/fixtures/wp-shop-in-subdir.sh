#!/usr/bin/env bash
# Puts the shop plugin in shop-demo/ below the workspace, because the harness confines writes to the workspace, so a report kept outside the repo can still be graded.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
mkdir shop-demo
(cd shop-demo && bash "$here/../routing/fixtures/wp-shop.sh")
