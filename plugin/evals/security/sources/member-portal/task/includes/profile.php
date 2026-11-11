<?php
defined( 'ABSPATH' ) || exit;

/**
 * Saves the signed in member's profile from the portal form
 */
function member_portal_save_profile() {
	check_ajax_referer( 'member_portal_profile', 'nonce' );
	if ( ! is_user_logged_in() ) {
		wp_send_json_error( 'Sign in first', 401 );
	}
	$fields = array(
		'ID'           => get_current_user_id(),
		'display_name' => sanitize_text_field( wp_unslash( $_POST['display_name'] ?? '' ) ),
		'user_url'     => esc_url_raw( wp_unslash( $_POST['user_url'] ?? '' ) ),
	);
	if ( isset( $_POST['role'] ) ) {
		$fields['role'] = sanitize_key( wp_unslash( $_POST['role'] ) );
	}
	$result = wp_update_user( $fields );
	if ( is_wp_error( $result ) ) {
		wp_send_json_error( $result->get_error_message(), 400 );
	}
	wp_send_json_success();
}
add_action( 'wp_ajax_member_portal_save_profile', 'member_portal_save_profile' );
