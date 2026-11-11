#!/usr/bin/env bash
# Seeds a freshly bootstrapped WordPress plugin, acme-sync, committed on main, so a run starts at its first feature.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
source "$here/empty-with-init.sh"
node "$HOME/.pipeline-cli/bin/pipeline" init --mode new --path . --yes --answer type=wordpress-plugin --answer name=acme-sync --answer distributed=no --answer peer_review=yes > /dev/null
printf '.pipeline/work/\n' >> .gitignore
git add -A
git commit -q --no-verify -m "chore: bootstrap acme-sync"
