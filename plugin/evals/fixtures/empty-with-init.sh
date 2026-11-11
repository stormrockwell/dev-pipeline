#!/usr/bin/env bash
# Leaves the workspace empty and installs the pipeline CLI with its init templates, because bootstrap starts from nothing.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
source "$here/pipeline-cli.sh"
# Init reads templates/ beside the CLI's folder, so the copy in the run's home needs them too.
cp -R "$root/templates" "$HOME/templates"
git config --global user.email dana@example.com
git config --global user.name "Dana Dev"
