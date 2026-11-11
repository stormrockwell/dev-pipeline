<?php
defined( 'ABSPATH' ) || exit;

/**
 * Counts how often each product was wished since a date, for the shop manager's report
 */
function wishlist_report_rows( $since ) {
	global $wpdb;
	if ( ! current_user_can( 'manage_options' ) ) {
		return array();
	}
	return $wpdb->get_results(
		$wpdb->prepare(
			'SELECT product_id, COUNT(*) AS wished FROM %i WHERE added >= %s GROUP BY product_id ORDER BY wished DESC LIMIT %d',
			$wpdb->prefix . 'wishlist_items',
			gmdate( 'Y-m-d H:i:s', strtotime( $since ) ?: 0 ),
			20
		)
	);
}

/**
 * Finds products whose title holds a typed phrase
 */
function wishlist_find_products( $phrase ) {
	global $wpdb;
	return $wpdb->get_col(
		$wpdb->prepare(
			"SELECT ID FROM {$wpdb->posts} WHERE post_type = 'product' AND post_status = 'publish' AND post_title LIKE %s LIMIT 20",
			'%' . $wpdb->esc_like( $phrase ) . '%'
		)
	);
}
