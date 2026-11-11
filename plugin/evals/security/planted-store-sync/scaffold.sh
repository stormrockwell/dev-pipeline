#!/usr/bin/env bash
# Order sync, feed preview, return link and reset, built as task 1 and open in its first review round.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
sources="$here/../sources/store-sync"
title="Order sync, feed preview, return link and reset"
description="Add the 1.0 sync features: sending each paid order to the fulfillment partner, a feed preview editors use before importing a supplier's product feed, a return link that sends the shopper back to the page they came from, and a reset button that clears the synced order records."
source "$here/../fixtures/security-in-review.sh"
