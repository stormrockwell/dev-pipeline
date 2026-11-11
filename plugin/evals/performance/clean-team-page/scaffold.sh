#!/usr/bin/env bash
# A team page shortcode that stays inside its declared ceiling of 50 members.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
sources="$here/../sources/team-page"
title="A team page shortcode"
description="Add a shortcode that lists the team members as cards."
source "$here/../fixtures/performance-in-review.sh"
