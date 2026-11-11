<?php
defined( 'ABSPATH' ) || exit;

/**
 * Saves the address the signed in user wants notices sent to
 */
function notify_save_email() {
	if ( ! is_user_logged_in() ) {
		wp_send_json_error( 'Sign in first', 401 );
	}
	$email = sanitize_email( wp_unslash( $_POST['email'] ?? '' ) );
	if ( ! is_email( $email ) ) {
		wp_send_json_error( 'Invalid address', 400 );
	}
	wp_update_user( array( 'ID' => get_current_user_id(), 'user_email' => $email ) );
	wp_send_json_success();
}
add_action( 'wp_ajax_notify_save_email', 'notify_save_email' );
