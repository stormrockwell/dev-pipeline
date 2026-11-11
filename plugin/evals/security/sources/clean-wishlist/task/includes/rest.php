<?php
defined( 'ABSPATH' ) || exit;

/**
 * Registers the routes a signed in shopper uses to change their own wishlist
 */
function wishlist_register_routes() {
	register_rest_route(
		'wishlist/v1',
		'/items',
		array(
			array(
				'methods'             => 'POST',
				'callback'            => 'wishlist_add_item',
				'permission_callback' => static function () {
					return current_user_can( 'read' );
				},
				'args'                => array( 'product_id' => array( 'type' => 'integer', 'required' => true ) ),
			),
		)
	);
	register_rest_route(
		'wishlist/v1',
		'/items/(?P<id>\d+)',
		array(
			array(
				'methods'             => 'DELETE',
				'callback'            => 'wishlist_remove_item',
				'permission_callback' => static function () {
					return current_user_can( 'read' );
				},
			),
		)
	);
}
add_action( 'rest_api_init', 'wishlist_register_routes' );

/**
 * Adds a published product to the signed in shopper's list
 */
function wishlist_add_item( WP_REST_Request $request ) {
	global $wpdb;
	$product_id = absint( $request->get_param( 'product_id' ) );
	if ( 'product' !== get_post_type( $product_id ) || 'publish' !== get_post_status( $product_id ) ) {
		return new WP_Error( 'wishlist_not_found', 'No such product', array( 'status' => 404 ) );
	}
	$table   = $wpdb->prefix . 'wishlist_items';
	$user_id = get_current_user_id();
	$limit   = (int) get_option( 'wishlist_limit', 50 );
	$count   = (int) $wpdb->get_var( $wpdb->prepare( 'SELECT COUNT(*) FROM %i WHERE user_id = %d', $table, $user_id ) );
	if ( $count >= $limit ) {
		return new WP_Error( 'wishlist_full', 'The list is full', array( 'status' => 400 ) );
	}
	$existing = $wpdb->get_var( $wpdb->prepare( 'SELECT id FROM %i WHERE user_id = %d AND product_id = %d', $table, $user_id, $product_id ) );
	if ( null !== $existing ) {
		return rest_ensure_response( array( 'id' => (int) $existing ) );
	}
	$wpdb->insert(
		$table,
		array(
			'user_id'    => $user_id,
			'product_id' => $product_id,
			'added'      => current_time( 'mysql', true ),
		),
		array( '%d', '%d', '%s' )
	);
	return rest_ensure_response( array( 'id' => $wpdb->insert_id ) );
}

/**
 * Removes one of the signed in shopper's own rows
 */
function wishlist_remove_item( WP_REST_Request $request ) {
	global $wpdb;
	$deleted = $wpdb->delete(
		$wpdb->prefix . 'wishlist_items',
		array(
			'id'      => absint( $request['id'] ),
			'user_id' => get_current_user_id(),
		),
		array( '%d', '%d' )
	);
	return rest_ensure_response( array( 'deleted' => (bool) $deleted ) );
}
