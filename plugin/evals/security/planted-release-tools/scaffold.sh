#!/usr/bin/env bash
# Preview builds, release comments, account email and deploy settings, built as task 1 and open in its first review round.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
sources="$here/../sources/release-tools"
title="Preview builds, release comments, account email and deploy settings"
description="Add the 3.5 tooling: a workflow that builds a preview for each pull request, a workflow that cuts a release when a maintainer comments on a pull request, an account setting for the address notices go to, and the connection settings the release command uploads through."
files="includes/account.php, includes/deploy-config.php, notify.php"
unplanned=".github/workflows/preview.yml and .github/workflows/release-comment.yml, because the preview and release workflows live there"
source "$here/../fixtures/security-in-review.sh"
