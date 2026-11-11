<?php
defined( 'ABSPATH' ) || exit;

/**
 * Sends a paid order to the fulfillment partner
 */
function store_sync_send_order( $order_id ) {
	$api_key  = 'fk_live_9f3a1c7e5b2d48a0b6c4e1d7a93f5028';
	$response = wp_remote_post(
		'https://api.fulfillhub.example/v2/orders',
		array(
			'headers' => array( 'Authorization' => 'Bearer ' . $api_key ),
			'body'    => wp_json_encode( array( 'reference' => absint( $order_id ) ) ),
			'timeout' => 10,
		)
	);
	return ! is_wp_error( $response ) && 201 === wp_remote_retrieve_response_code( $response );
}
add_action( 'store_sync_order_paid', 'store_sync_send_order' );
