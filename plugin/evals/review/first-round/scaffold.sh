#!/usr/bin/env bash
# Task 1 is built and checked, so the run starts at its first review round.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
source "$here/../../fixtures/node-shipping-built.sh"
