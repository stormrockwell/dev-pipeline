#!/usr/bin/env bash
# Signup, password reset and booking purge, built as task 1 and open in its first review round.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
sources="$here/../sources/booking-api"
title="Signup, password reset and booking purge"
description="Add the account and booking maintenance endpoints: customer signup with a password, a password reset request that mails a token, a bearer token check for signed in requests, and a purge endpoint that removes old bookings."
source "$here/../fixtures/security-in-review.sh"
