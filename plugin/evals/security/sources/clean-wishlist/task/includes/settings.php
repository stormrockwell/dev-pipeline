<?php
defined( 'ABSPATH' ) || exit;

/**
 * Saves the number of items a shopper may keep on one list
 */
function wishlist_save_limit() {
	check_admin_referer( 'wishlist_save_limit' );
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( 'Not allowed', '', array( 'response' => 403 ) );
	}
	$limit = isset( $_POST['limit'] ) ? absint( wp_unslash( $_POST['limit'] ) ) : 50;
	update_option( 'wishlist_limit', min( max( $limit, 1 ), 500 ) );
	wp_safe_redirect( admin_url( 'options-general.php?page=wishlist&saved=1' ) );
	exit;
}
add_action( 'admin_post_wishlist_save_limit', 'wishlist_save_limit' );
