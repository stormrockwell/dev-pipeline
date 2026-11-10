#!/usr/bin/env bash
# Seeds the shop plugin and the pipeline CLI, because quick changes and spikes run pipeline check.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
bash "$here/../routing/fixtures/wp-shop.sh"
source "$here/pipeline-cli.sh"
