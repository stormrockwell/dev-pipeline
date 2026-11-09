#!/usr/bin/env bash
set -euo pipefail
git init -q -b main
git config user.email spike@example.com
git config user.name Spike
cat > demo-plugin.php <<'PHP'
<?php
/**
 * Plugin Name: Demo Plugin
 */

function demo_init() {
	add_action( 'wp_footer', 'demo_footer' );
}
add_action( 'init', 'demo_init' );

function demo_footer() {
	echo esc_html( get_option( 'demo_footer_text', '' ) );
}
PHP
git add . && git commit -q -m "feat: initial plugin"
cat >> demo-plugin.php <<'PHP'

function demo_delete_row() {
	global $wpdb;
	$wpdb->query( "DELETE FROM {$wpdb->prefix}demo_rows WHERE id = {$_GET['id']}" );
}
add_action( 'init', 'demo_delete_row' );
PHP
git commit -q -am "feat: add row deletion"
