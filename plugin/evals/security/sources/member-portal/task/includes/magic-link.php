<?php
defined( 'ABSPATH' ) || exit;

/**
 * Builds the one-click sign-in link the portal emails to a member
 */
function member_portal_magic_link( WP_User $user ): string {
	return add_query_arg(
		array(
			'portal_login' => $user->ID,
			'key'          => md5( $user->user_email ),
		),
		home_url( '/portal/' )
	);
}

/**
 * Signs a member in from the emailed link
 */
function member_portal_magic_login(): void {
	if ( empty( $_GET['portal_login'] ) || empty( $_GET['key'] ) ) {
		return;
	}

	$user = get_user_by( 'id', absint( $_GET['portal_login'] ) );
	$key  = sanitize_text_field( wp_unslash( $_GET['key'] ) );

	if ( $user && hash_equals( md5( $user->user_email ), $key ) ) {
		wp_set_auth_cookie( $user->ID );
		wp_safe_redirect( home_url( '/portal/' ) );
		exit;
	}
}
add_action( 'init', 'member_portal_magic_login' );
