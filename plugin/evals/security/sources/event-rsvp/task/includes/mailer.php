<?php
defined( 'ABSPATH' ) || exit;

/**
 * Sends the confirmation mail for a saved RSVP and keeps a trace of each send for support
 */
function event_rsvp_send_confirmation( $name, $email, $phone, $event_id ) {
	$subject = sprintf( 'You are on the list for %s', get_the_title( $event_id ) );
	$sent    = wp_mail( $email, $subject, 'See you there, ' . $name . '.' );
	$line    = sprintf( "%s sent=%d name=%s email=%s phone=%s\n", gmdate( 'c' ), $sent ? 1 : 0, $name, $email, $phone );
	file_put_contents( WP_CONTENT_DIR . '/uploads/event-rsvp-mail.log', $line, FILE_APPEND );
	return $sent;
}
