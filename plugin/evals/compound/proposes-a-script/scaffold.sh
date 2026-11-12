#!/usr/bin/env bash
# Three sessions of run logs where the worktree setup repeats, so the compounder has a script to propose.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
source "$here/../fixtures/shop-with-runs.sh"
