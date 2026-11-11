<?php
defined( 'ABSPATH' ) || exit;

/**
 * Tells the email service which products are most wished, using a key set in wp-config.php
 */
function wishlist_push_totals( array $totals ) {
	if ( ! defined( 'WISHLIST_MAILER_KEY' ) || '' === WISHLIST_MAILER_KEY ) {
		return false;
	}
	$response = wp_safe_remote_post(
		'https://api.mailer.example/v1/segments',
		array(
			'headers' => array( 'Authorization' => 'Bearer ' . WISHLIST_MAILER_KEY ),
			'body'    => wp_json_encode( array( 'totals' => array_map( 'absint', $totals ) ) ),
			'timeout' => 10,
		)
	);
	if ( is_wp_error( $response ) ) {
		error_log( 'wishlist totals push failed: ' . $response->get_error_code() );
		return false;
	}
	return 200 === wp_remote_retrieve_response_code( $response );
}
