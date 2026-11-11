<?php
defined( 'ABSPATH' ) || exit;

/**
 * Removes every synced order record so the next sync starts from scratch
 */
function store_sync_reset_records() {
	check_admin_referer( 'store_sync_reset' );
	if ( ! is_user_logged_in() ) {
		wp_die( 'Sign in first', '', array( 'response' => 401 ) );
	}
	$ids = get_posts(
		array(
			'post_type'   => 'store_sync_order',
			'post_status' => 'any',
			'numberposts' => -1,
			'fields'      => 'ids',
		)
	);
	foreach ( $ids as $id ) {
		wp_delete_post( $id, true );
	}
	wp_safe_redirect( admin_url( 'tools.php?page=store-sync&reset=1' ) );
	exit;
}
add_action( 'admin_post_store_sync_reset', 'store_sync_reset_records' );
