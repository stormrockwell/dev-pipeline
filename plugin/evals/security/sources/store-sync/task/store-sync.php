<?php
/**
 * Plugin Name: Store Sync
 * Version: 1.0.0
 */

defined( 'ABSPATH' ) || exit;

require_once __DIR__ . '/includes/fulfillment.php';
require_once __DIR__ . '/includes/feed-preview.php';
require_once __DIR__ . '/includes/return-link.php';
require_once __DIR__ . '/includes/cleanup.php';

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
