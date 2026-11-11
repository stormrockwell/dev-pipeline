<?php
/**
 * Plugin Name: Store Sync
 * Version: 0.9.0
 */

defined( 'ABSPATH' ) || exit;

/**
 * Registers the post type that holds one record per synced order
 */
function store_sync_register_type() {
	register_post_type(
		'store_sync_order',
		array(
			'label'  => 'Synced orders',
			'public' => false,
		)
	);
}
add_action( 'init', 'store_sync_register_type' );
