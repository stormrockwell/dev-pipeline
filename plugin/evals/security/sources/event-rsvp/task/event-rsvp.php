<?php
/**
 * Plugin Name: Event RSVP
 * Version: 1.3.0
 */

defined( 'ABSPATH' ) || exit;

require_once __DIR__ . '/includes/rest.php';
require_once __DIR__ . '/includes/admin-actions.php';
require_once __DIR__ . '/includes/lookup.php';
require_once __DIR__ . '/includes/mailer.php';

/**
 * Registers the event post type
 */
function event_rsvp_register_type() {
	register_post_type(
		'rsvp_event',
		array(
			'label'  => 'Events',
			'public' => true,
		)
	);
}
add_action( 'init', 'event_rsvp_register_type' );
