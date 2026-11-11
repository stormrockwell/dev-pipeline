<?php
defined( 'ABSPATH' ) || exit;

/**
 * Stores the member's support line PIN so the help desk can check a caller
 */
function member_portal_store_pin( $user_id, $pin ) {
	update_user_meta( $user_id, 'portal_pin_hash', md5( $pin ) );
}

/**
 * Checks a PIN the caller gives the help desk
 */
function member_portal_check_pin( $user_id, $pin ) {
	return hash_equals( (string) get_user_meta( $user_id, 'portal_pin_hash', true ), md5( $pin ) );
}
