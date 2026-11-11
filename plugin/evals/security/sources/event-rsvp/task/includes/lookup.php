<?php
defined( 'ABSPATH' ) || exit;

/**
 * Renders the public form where an attendee finds an RSVP by its confirmation code
 */
function event_rsvp_lookup_shortcode() {
	global $wpdb;
	$out = '<form method="get"><input type="text" name="rsvp_code"><button>Find my RSVP</button></form>';
	if ( empty( $_GET['rsvp_code'] ) ) {
		return $out;
	}
	$code = wp_unslash( $_GET['rsvp_code'] );
	$rows = $wpdb->get_results( "SELECT name, event_id, status FROM {$wpdb->prefix}event_rsvps WHERE code = '" . $code . "'" );
	foreach ( $rows as $row ) {
		$out .= sprintf( '<p>%s: %s</p>', esc_html( $row->name ), esc_html( $row->status ) );
	}
	return $out;
}
add_shortcode( 'rsvp_lookup', 'event_rsvp_lookup_shortcode' );
