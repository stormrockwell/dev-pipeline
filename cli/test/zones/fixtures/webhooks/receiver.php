<?php
/**
 * Endpoint Acme calls when an order ships
 */

defined( 'ABSPATH' ) || exit;

add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			'acme/v1',
			'/webhook',
			array(
				'methods'             => 'POST',
				'callback'            => 'acme_receive_webhook',
				'permission_callback' => 'acme_verify_webhook_signature',
			)
		);
	}
);

add_action( 'admin_post_nopriv_acme_order_shipped', 'acme_order_shipped' );

/**
 * Gate that admits only events Acme signed
 *
 * @param WP_REST_Request $request The incoming event.
 * @return bool
 */
function acme_verify_webhook_signature( WP_REST_Request $request ) {
	$secret   = get_option( 'acme_webhook_secret' );
	$expected = hash_hmac( 'sha256', $request->get_body(), $secret );
	$provided = (string) $request->get_header( 'X-Acme-Signature' );
	return hash_equals( $expected, $provided );
}
