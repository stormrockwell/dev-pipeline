<?php
defined( 'ABSPATH' ) || exit;

/**
 * Loads the support chat widget on portal pages
 */
function member_portal_support_widget() {
	if ( ! is_page( 'portal' ) ) {
		return;
	}
	echo '<script src="http://widgets.helpnow.example/chat/v2/loader.js" async></script>';
}
add_action( 'wp_footer', 'member_portal_support_widget' );
