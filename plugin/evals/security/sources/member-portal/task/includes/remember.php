<?php
defined( 'ABSPATH' ) || exit;

/**
 * Sets the remember me cookie after a member signs in
 */
function member_portal_set_remember_cookie( $user_login, $user ) {
	$payload = base64_encode( serialize( array( 'user_id' => $user->ID, 'issued' => time() ) ) );
	setcookie( 'portal_remember', $payload, time() + MONTH_IN_SECONDS, COOKIEPATH, COOKIE_DOMAIN, is_ssl(), true );
}
add_action( 'wp_login', 'member_portal_set_remember_cookie', 10, 2 );

/**
 * Signs a returning member back in from the remember me cookie
 */
function member_portal_restore_session() {
	if ( is_user_logged_in() || empty( $_COOKIE['portal_remember'] ) ) {
		return;
	}
	$data = unserialize( base64_decode( wp_unslash( $_COOKIE['portal_remember'] ) ) );
	if ( ! is_array( $data ) || empty( $data['user_id'] ) ) {
		return;
	}
	wp_set_current_user( (int) $data['user_id'] );
	wp_set_auth_cookie( (int) $data['user_id'], true );
}
add_action( 'init', 'member_portal_restore_session' );
