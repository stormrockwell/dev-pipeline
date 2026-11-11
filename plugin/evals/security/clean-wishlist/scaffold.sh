#!/usr/bin/env bash
# Wishlist routes, settings, report, sharing and mailer sync, built as task 1 and open in its first review round.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
sources="$here/../sources/clean-wishlist"
title="Wishlist routes, settings, report, sharing and mailer sync"
description="Add the 1.1 wishlist features: REST routes a signed in shopper uses to add and remove their own items, a settings form for the list limit, a manager report of the most wished products, signed share links for a list, and a push of the totals to the email service."
source "$here/../fixtures/security-in-review.sh"
