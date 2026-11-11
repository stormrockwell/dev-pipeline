<?php
defined( 'ABSPATH' ) || exit;

/**
 * Saves the address that receives a copy of every RSVP confirmation
 */
function event_rsvp_save_copy_address() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( 'Not allowed', '', array( 'response' => 403 ) );
	}
	$address = isset( $_POST['copy_address'] ) ? sanitize_email( wp_unslash( $_POST['copy_address'] ) ) : '';
	if ( is_email( $address ) ) {
		update_option( 'event_rsvp_copy_address', $address );
	}
	wp_safe_redirect( admin_url( 'edit.php?post_type=rsvp_event&page=rsvp-settings&saved=1' ) );
	exit;
}
add_action( 'admin_post_event_rsvp_save_copy_address', 'event_rsvp_save_copy_address' );
