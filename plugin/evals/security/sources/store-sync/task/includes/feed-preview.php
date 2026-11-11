<?php
defined( 'ABSPATH' ) || exit;

/**
 * Fetches a supplier's product feed so an editor can preview it before importing
 */
function store_sync_preview_feed() {
	check_ajax_referer( 'store_sync_preview', 'nonce' );
	if ( ! current_user_can( 'edit_posts' ) ) {
		wp_send_json_error( 'Not allowed', 403 );
	}
	$url      = esc_url_raw( wp_unslash( $_POST['feed_url'] ?? '' ) );
	$response = wp_remote_get( $url, array( 'timeout' => 10 ) );
	if ( is_wp_error( $response ) ) {
		wp_send_json_error( $response->get_error_message(), 502 );
	}
	wp_send_json_success( array( 'preview' => substr( wp_remote_retrieve_body( $response ), 0, 4000 ) ) );
}
add_action( 'wp_ajax_store_sync_preview_feed', 'store_sync_preview_feed' );
