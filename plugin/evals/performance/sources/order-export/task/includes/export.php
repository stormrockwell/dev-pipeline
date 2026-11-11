<?php
defined( 'ABSPATH' ) || exit;

/**
 * Sends every order as a CSV download
 */
function order_export_send() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( esc_html__( 'Not allowed.', 'order-export' ), 403 );
	}

	global $wpdb;
	$rows = $wpdb->get_results( "SELECT ID, post_date, post_title FROM {$wpdb->posts} WHERE post_type = 'shop_order'", ARRAY_A );

	$csv = "id,date,title\n";
	foreach ( $rows as $row ) {
		$csv .= implode( ',', array_map( 'order_export_cell', $row ) ) . "\n";
	}

	header( 'Content-Type: text/csv' );
	header( 'Content-Disposition: attachment; filename="orders.csv"' );
	echo $csv; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	exit;
}
add_action( 'admin_post_order_export', 'order_export_send' );

/**
 * Quotes one CSV cell
 */
function order_export_cell( $value ) {
	return '"' . str_replace( '"', '""', (string) $value ) . '"';
}
