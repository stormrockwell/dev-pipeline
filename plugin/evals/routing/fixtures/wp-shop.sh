#!/usr/bin/env bash
# Seeds a small WordPress shop plugin with a footer typo and a checkout handler, so every routing request has real code to point at.
set -euo pipefail
git init -q -b main
git config user.email evals@example.com
git config user.name Evals

mkdir -p includes templates tests
cat > shop-demo.php <<'PHP'
<?php
/**
 * Plugin Name: Shop Demo
 * Version: 1.2.0
 * Requires PHP: 8.0
 */

defined( 'ABSPATH' ) || exit;

require __DIR__ . '/includes/checkout.php';
require __DIR__ . '/includes/orders-admin.php';

function shop_demo_footer() {
	include __DIR__ . '/templates/footer.php';
}
add_action( 'wp_footer', 'shop_demo_footer' );
PHP

cat > templates/footer.php <<'PHP'
<footer class="shop-demo-footer">
	<p>Copywrite 2026 Shop Demo. All rights reserved.</p>
</footer>
PHP

cat > includes/checkout.php <<'PHP'
<?php
defined( 'ABSPATH' ) || exit;

function shop_demo_checkout( WP_REST_Request $request ) {
	$cart  = shop_demo_cart( get_current_user_id() );
	$total = 0;
	foreach ( $cart['items'] as $item ) {
		$total += $item['price'] * $item['qty'];
	}
	$order_id = wp_insert_post(
		array(
			'post_type'   => 'shop_order',
			'post_status' => 'publish',
			'meta_input'  => array( 'total' => $total ),
		)
	);
	return rest_ensure_response( array( 'order' => $order_id, 'total' => $total ) );
}

function shop_demo_cart( $user_id ) {
	return get_user_meta( $user_id, 'shop_demo_cart', true );
}

add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			'shop-demo/v1',
			'/checkout',
			array(
				'methods'             => 'POST',
				'callback'            => 'shop_demo_checkout',
				'permission_callback' => 'is_user_logged_in',
			)
		);
	}
);
PHP

cat > includes/orders-admin.php <<'PHP'
<?php
defined( 'ABSPATH' ) || exit;

function shop_demo_orders_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$orders = get_posts( array( 'post_type' => 'shop_order', 'numberposts' => 50 ) );
	echo '<div class="wrap"><h1>' . esc_html__( 'Orders', 'shop-demo' ) . '</h1><table class="widefat">';
	foreach ( $orders as $order ) {
		printf( '<tr><td>%d</td><td>%s</td></tr>', (int) $order->ID, esc_html( get_post_meta( $order->ID, 'total', true ) ) );
	}
	echo '</table></div>';
}

add_action(
	'admin_menu',
	function () {
		add_menu_page( 'Orders', 'Orders', 'manage_options', 'shop-demo-orders', 'shop_demo_orders_page' );
	}
);
PHP

cat > tests/test-checkout.php <<'PHP'
<?php
class Test_Checkout extends WP_UnitTestCase {
	public function test_checkout_totals_the_cart() {
		$user = self::factory()->user->create();
		update_user_meta( $user, 'shop_demo_cart', array( 'items' => array( array( 'price' => 5, 'qty' => 2 ) ) ) );
		wp_set_current_user( $user );
		$response = shop_demo_checkout( new WP_REST_Request( 'POST', '/shop-demo/v1/checkout' ) );
		$this->assertSame( 10, $response->get_data()['total'] );
	}
}
PHP

git add . && git commit -q -m "feat: initial shop demo plugin"
