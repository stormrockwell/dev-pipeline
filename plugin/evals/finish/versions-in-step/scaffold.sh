#!/usr/bin/env bash
# A distributed WordPress plugin whose readme stable tag lags its header, with one task built and
# reviewed, so finish has a changelog entry to write and a version to bring into step.
set -euo pipefail
fixtures="$(dirname "$(realpath "${BASH_SOURCE[0]}")")/../../fixtures"
source "$fixtures/pipeline-cli.sh"

git init -q -b main
git config user.email dana@example.com
git config user.name "Dana Dev"

mkdir -p includes .pipeline/work/free-shipping
printf '.pipeline/work/\n' > .gitignore

cat > shop-demo.php <<'PHP'
<?php
/**
 * Plugin Name: Shop Demo
 * Version: 1.2.0
 * Requires PHP: 8.0
 */

defined( 'ABSPATH' ) || exit;

define( 'SHOP_DEMO_VERSION', '1.2.0' );

require __DIR__ . '/includes/shipping.php';
PHP

cat > readme.txt <<'TXT'
=== Shop Demo ===
Requires at least: 6.4
Requires PHP: 8.0
Stable tag: 1.1.0
License: GPLv2 or later

A small shop.
TXT

cat > includes/shipping.php <<'PHP'
<?php
defined( 'ABSPATH' ) || exit;

function shop_demo_qualifies_for_free_shipping( $total ) {
	return $total > 50;
}
PHP

cat > CHANGELOG.md <<'MD'
# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [1.2.0] - 2026-10-01

### Added

- Free shipping over 50.
MD

cat > .pipeline/profile.yml <<'YML'
project:
  type: wp-plugin
  name: shop-demo
  distributed: true
YML

git add .
git commit -q -m "feat(shipping): add free shipping"

cat > .pipeline/work/free-shipping/work-order.md <<'MD'
---
title: Let an order of exactly the threshold ship free
level: confirm
tasks:
  - id: 1
    title: Free shipping at the threshold
    files: [includes/shipping.php]
    tier: T2
    zones: []
---

## Task 1: Free shipping at the threshold
An order of exactly 50 ships free.
MD
node "$HOME/.pipeline-cli/bin/pipeline" schedule .pipeline/work/free-shipping/work-order.md > /dev/null

slug=free-shipping
fix_file=includes/shipping.php
fix_from='$total > 50'
fix_to='$total >= 50'
no_tdd="the developer declined a PHP test harness"
source "$fixtures/built-task.sh"

for gate in simplifier standards spec "quick security review"; do
  pipeline ledger gate "$order" --task 1 --gate "$gate" --result pass > /dev/null
done
