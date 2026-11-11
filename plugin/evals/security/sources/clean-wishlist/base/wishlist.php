<?php
/**
 * Plugin Name: Wishlist
 * Version: 1.0.0
 */

defined( 'ABSPATH' ) || exit;

/**
 * Prints the wishlist heart on product pages
 */
function wishlist_heart() {
	echo '<button class="wishlist-heart" type="button" aria-label="Add to wishlist"></button>';
}
add_action( 'woocommerce_single_product_summary', 'wishlist_heart' );
