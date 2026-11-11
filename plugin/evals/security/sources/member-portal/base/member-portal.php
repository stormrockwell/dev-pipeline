<?php
/**
 * Plugin Name: Member Portal
 * Version: 2.0.0
 */

defined( 'ABSPATH' ) || exit;

/**
 * Prints the portal link in the footer for signed in members
 */
function member_portal_footer_link() {
	if ( is_user_logged_in() ) {
		printf( '<a href="%s">Member portal</a>', esc_url( home_url( '/portal/' ) ) );
	}
}
add_action( 'wp_footer', 'member_portal_footer_link' );
