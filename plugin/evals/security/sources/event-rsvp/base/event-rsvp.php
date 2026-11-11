<?php
/**
 * Plugin Name: Event RSVP
 * Version: 1.2.0
 */

defined( 'ABSPATH' ) || exit;

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
