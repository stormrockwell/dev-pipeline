#!/usr/bin/env bash
# Seeds a WordPress banner plugin whose T2 task adds a REST route that saves the banner, built and
# checked, with its first review round open and every reviewer but security replied. The caller sets
# permission to the route's permission_callback.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
source "$here/pipeline-cli.sh"
pipeline() { node "$HOME/.pipeline-cli/bin/pipeline" "$@"; }

git init -q -b main
git config user.email dana@example.com
git config user.name "Dana Dev"
mkdir -p .pipeline/work/banner
printf '.pipeline/work/\n' > .gitignore

cat > shop-banner.php <<'PHP'
<?php
/**
 * Plugin Name: Shop Banner
 * Version: 1.0.0
 */

defined( 'ABSPATH' ) || exit;

/**
 * Prints the banner above the footer
 */
function shop_banner_render() {
	$text  = get_option( 'shop_banner_text', '' );
	$color = get_option( 'shop_banner_color', '#000000' );
	if ( '' === $text ) {
		return;
	}
	printf( '<div class="shop-banner" style="background:%s">%s</div>', esc_attr( $color ), esc_html( $text ) );
}
add_action( 'wp_footer', 'shop_banner_render' );
PHP
git add .
git commit -q -m "feat(banner): print the banner"

cat > .pipeline/work/banner/work-order.md <<'MD'
---
title: Let shop managers save the banner from the block editor
level: confirm
tasks:
  - id: 1
    title: A REST route that saves the banner
    files: [shop-banner.php, includes/rest.php]
    tier: T2
    zones: []
---

## Task 1: A REST route that saves the banner
Add `POST /wp-json/shop-banner/v1/banner`, taking `text` and `color`, which saves them as the shop_banner_text and shop_banner_color options. The block editor sidebar calls it for shop managers, who hold manage_options. The plugin has no test suite, and the developer declined one for this change.
MD
pipeline schedule .pipeline/work/banner/work-order.md > /dev/null

order=.pipeline/work/banner/work-order.md
wt="$PWD/.pipeline/work/banner/worktrees/1"
git worktree add -q -b wt/banner-1 "$wt"
pipeline brief "$order" 1 --worktree "$wt" --no-tdd "the plugin has no test suite, and the developer declined one" > /dev/null

mkdir -p "$wt/includes"
cat > "$wt/includes/rest.php" <<PHP
<?php
defined( 'ABSPATH' ) || exit;

/**
 * Registers the route the block editor sidebar saves the banner through
 */
function shop_banner_register_route() {
	register_rest_route(
		'shop-banner/v1',
		'/banner',
		array(
			'methods'             => 'POST',
			'callback'            => 'shop_banner_save',
			'permission_callback' => $permission,
			'args'                => array(
				'text'  => array( 'type' => 'string', 'required' => true ),
				'color' => array( 'type' => 'string', 'default' => '#000000' ),
			),
		)
	);
}
add_action( 'rest_api_init', 'shop_banner_register_route' );

/**
 * Saves the banner text and color as options
 */
function shop_banner_save( WP_REST_Request \$request ) {
	update_option( 'shop_banner_text', sanitize_text_field( \$request->get_param( 'text' ) ) );
	update_option( 'shop_banner_color', sanitize_hex_color( \$request->get_param( 'color' ) ) ?? '#000000' );
	return rest_ensure_response( array( 'saved' => true ) );
}
PHP
perl -0pi -e "s/(defined\( 'ABSPATH' \) \|\| exit;\n)/\$1\nrequire __DIR__ . '\/includes\/rest.php';\n/" "$wt/shop-banner.php"
git -C "$wt" add -A
git -C "$wt" commit -q -m "feat(banner): save the banner through a REST route" -m "Co-Authored using AI"

printf 'Status: DONE\n\nAdded POST /wp-json/shop-banner/v1/banner, which saves text and color as options.\n\nTask: %s\n' "$wt" > "$wt/.pipeline/task/report.md"
pipeline task-check --task "$wt" > /dev/null

pipeline review start "$order" --task 1 > /dev/null
for reviewer in simplifier spec standards; do
  package="$PWD/.pipeline/work/banner/review/task-1/round-1/package-$reviewer.md"
  message="$(printf 'Reviewed.\n\n```json\n{"findings": []}\n```\n\nPackage: %s' "$package")"
  node -e 'process.stdout.write(JSON.stringify({ hook_event_name: "SubagentStop", last_assistant_message: process.argv[1] }))' "$message" | pipeline review save --hook
done
