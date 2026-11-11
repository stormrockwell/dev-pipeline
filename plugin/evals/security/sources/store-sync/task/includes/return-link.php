<?php
defined( 'ABSPATH' ) || exit;

/**
 * Sends the shopper back to the page they came from once the order page has recorded the sync
 */
function store_sync_return_shopper() {
	if ( empty( $_GET['store_sync_return'] ) ) {
		return;
	}
	wp_redirect( wp_unslash( $_GET['store_sync_return'] ) );
	exit;
}
add_action( 'template_redirect', 'store_sync_return_shopper' );
