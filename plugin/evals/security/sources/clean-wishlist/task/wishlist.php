<?php
/**
 * Plugin Name: Wishlist
 * Version: 1.1.0
 */

defined( 'ABSPATH' ) || exit;

require_once __DIR__ . '/includes/rest.php';
require_once __DIR__ . '/includes/settings.php';
require_once __DIR__ . '/includes/report.php';
require_once __DIR__ . '/includes/share.php';
require_once __DIR__ . '/includes/sync.php';

/**
 * Prints the wishlist heart on product pages
 */
function wishlist_heart() {
	echo '<button class="wishlist-heart" type="button" aria-label="Add to wishlist"></button>';
}
add_action( 'woocommerce_single_product_summary', 'wishlist_heart' );
