<?php
defined( 'ABSPATH' ) || exit;

/**
 * Renders the price list shortcode, one line per product
 */
function shop_prices_render() {
	$ids = get_posts(
		array(
			'post_type'      => 'product',
			'posts_per_page' => 24,
			'fields'         => 'ids',
		)
	);

	$out = '<ul class="shop-prices">';
	foreach ( $ids as $id ) {
		$price = get_post_meta( $id, '_price', true );
		$out  .= sprintf( '<li>%s <span>%s</span></li>', esc_html( get_the_title( $id ) ), esc_html( $price ) );
	}
	return $out . '</ul>';
}
add_shortcode( 'shop_prices', 'shop_prices_render' );
