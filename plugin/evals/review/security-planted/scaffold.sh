#!/usr/bin/env bash
# The banner route lets anyone save the banner, because its permission_callback is __return_true.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
permission="'__return_true'"
source "$here/../../fixtures/wp-banner-in-review.sh"
