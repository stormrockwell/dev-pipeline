<?php
/**
 * Plugin Name: Notify
 * Version: 3.5.0
 */

defined( 'ABSPATH' ) || exit;

require_once __DIR__ . '/includes/account.php';
require_once __DIR__ . '/includes/deploy-config.php';

/**
 * Prints the unread count in the admin bar
 */
function notify_admin_bar( $bar ) {
	$bar->add_node(
		array(
			'id'    => 'notify',
			'title' => sprintf( 'Notices (%d)', absint( get_user_meta( get_current_user_id(), 'notify_unread', true ) ) ),
		)
	);
}
add_action( 'admin_bar_menu', 'notify_admin_bar', 90 );
