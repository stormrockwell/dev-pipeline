<?php
defined( 'ABSPATH' ) || exit;

/**
 * Registers the route the event editor sidebar uses to set an event's capacity
 */
function event_rsvp_register_routes() {
	register_rest_route(
		'event-rsvp/v1',
		'/capacity',
		array(
			'methods'             => 'POST',
			'callback'            => 'event_rsvp_set_capacity',
			'permission_callback' => '__return_true',
			'args'                => array(
				'event_id' => array( 'type' => 'integer', 'required' => true ),
				'capacity' => array( 'type' => 'integer', 'required' => true ),
			),
		)
	);
}
add_action( 'rest_api_init', 'event_rsvp_register_routes' );

/**
 * Stores the capacity on the event
 */
function event_rsvp_set_capacity( WP_REST_Request $request ) {
	$event_id = absint( $request->get_param( 'event_id' ) );
	if ( 'rsvp_event' !== get_post_type( $event_id ) ) {
		return new WP_Error( 'event_rsvp_not_found', 'No such event', array( 'status' => 404 ) );
	}
	update_post_meta( $event_id, '_event_rsvp_capacity', absint( $request->get_param( 'capacity' ) ) );
	return rest_ensure_response( array( 'saved' => true ) );
}
