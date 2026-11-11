#!/usr/bin/env bash
# The clean control: the same banner route, open only to users who hold manage_options.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
permission="static function () {
				return current_user_can( 'manage_options' );
			}"
source "$here/../../fixtures/wp-banner-in-review.sh"
