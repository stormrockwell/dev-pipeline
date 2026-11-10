#!/usr/bin/env bash
# Sourced by scaffolds. It copies the CLI into the run's home, because the sandboxed agent can read that home but not this checkout.
pipeline_cli_root() {
  local dir
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  while [ "$dir" != / ] && [ ! -f "$dir/cli/bin/pipeline" ]; do dir="$(dirname "$dir")"; done
  printf '%s\n' "$dir"
}
root="$(pipeline_cli_root)"
mkdir -p "$HOME/.pipeline-cli"
cp -R "$root/cli/bin" "$root/cli/src" "$root/cli/package.json" "$HOME/.pipeline-cli/"
