#!/usr/bin/env bash
# A shop with a cached fetch of merged PRs and no run logs, so /compound runs the quality half alone.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
source "$here/../fixtures/shop-with-merged-prs.sh"
