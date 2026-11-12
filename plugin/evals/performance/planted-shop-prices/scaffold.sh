#!/usr/bin/env bash
# A price list shortcode whose product loop reads each price with get_post_meta.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
sources="$here/../sources/shop-prices"
title="A price list shortcode"
description="Add a shortcode that lists the shop's 24 newest products with their prices."
source "$here/../fixtures/performance-in-review.sh"
