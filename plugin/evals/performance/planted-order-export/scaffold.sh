#!/usr/bin/env bash
# An order export that loads every order into memory.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
sources="$here/../sources/order-export"
title="An order export"
description="Add an admin download that exports every order as a CSV."
source "$here/../fixtures/performance-in-review.sh"
