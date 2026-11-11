#!/usr/bin/env bash
# Notes, password reset and staff purge, built as task 1 and open in its first review round.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
sources="$here/../sources/clean-notes"
title="Notes, password reset and staff purge"
description="Add the notes API: a bearer token check, a note list and delete that work on the signed in user's own notes, a password reset request that mails a token, and a staff endpoint that purges old notes."
source "$here/../fixtures/security-in-review.sh"
