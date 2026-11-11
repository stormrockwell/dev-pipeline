<?php
defined( 'ABSPATH' ) || exit;

/**
 * Builds the signed link that shows one shopper's list to anyone who holds it
 */
function wishlist_share_url( $user_id ) {
	$signature = hash_hmac( 'sha256', 'wishlist-share:' . absint( $user_id ), wp_salt( 'auth' ) );
	return add_query_arg(
		array(
			'wishlist_user' => absint( $user_id ),
			'sig'           => $signature,
		),
		home_url( '/wishlist/' )
	);
}

/**
 * Sends a visitor to the shared list, or back to the home page when the link is not valid
 */
function wishlist_open_share() {
	if ( empty( $_GET['wishlist_user'] ) || empty( $_GET['sig'] ) ) {
		return;
	}
	$user_id  = absint( $_GET['wishlist_user'] );
	$expected = hash_hmac( 'sha256', 'wishlist-share:' . $user_id, wp_salt( 'auth' ) );
	if ( ! hash_equals( $expected, sanitize_text_field( wp_unslash( $_GET['sig'] ) ) ) ) {
		wp_safe_redirect( home_url( '/' ) );
		exit;
	}
	$target = isset( $_GET['back'] ) ? wp_validate_redirect( esc_url_raw( wp_unslash( $_GET['back'] ) ), home_url( '/' ) ) : home_url( '/' );
	wp_safe_redirect( $target );
	exit;
}
add_action( 'template_redirect', 'wishlist_open_share' );
