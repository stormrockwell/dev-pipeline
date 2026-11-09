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

function demo_footer() {
	echo esc_html( get_option( 'demo_footer_text', '' ) );
}
add_action( 'wp_footer', 'demo_footer' );
PHP
git add . && git commit -q -m "feat: initial plugin"
cat >> demo-plugin.php <<'PHP'

function demo_save_settings() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( esc_html__( 'Forbidden', 'demo' ), 403 );
	}
	check_admin_referer( 'demo_save_settings' );
	update_option( 'demo_footer_text', sanitize_text_field( wp_unslash( $_POST['footer_text'] ?? '' ) ) );
	wp_safe_redirect( admin_url( 'options-general.php?page=demo' ) );
	exit;
}
add_action( 'admin_post_demo_save_settings', 'demo_save_settings' );

function demo_count_rows( $status ) {
	global $wpdb;
	return (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}demo_rows WHERE status = %s", $status ) );
}
PHP
git commit -q -am "feat: add safe settings handler and row count"
