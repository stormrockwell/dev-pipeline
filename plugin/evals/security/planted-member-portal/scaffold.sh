#!/usr/bin/env bash
# Remember me, profile edits, sign-in links and chat widget, built as task 1 and open in its first review round.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
sources="$here/../sources/member-portal"
title="Remember me, profile edits, sign-in links and chat widget"
description="Add the 2.1 portal features: a remember me cookie that signs a returning member back in, a profile form that saves display name and web address, a one-click sign-in link emailed to members, and the support chat widget on the portal page."
source "$here/../fixtures/security-in-review.sh"
