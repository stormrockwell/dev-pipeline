#!/usr/bin/env bash
# Seeds a WordPress shop plugin with zone and non-zone code, and installs the pipeline CLI from this
# checkout into .tools/. Each case's scaffold.sh sources it, then adds its own work order or branch.
# Run the suite with PATH=".tools/bin:$PATH", because the agent's sandbox reads only its workspace.
set -euo pipefail
cli="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../cli" && pwd)"

git init -q -b main
git config user.email dana@example.com
git config user.name "Dana Dev"

mkdir -p .tools/pipeline-cli .tools/bin
cp -R "$cli/bin" "$cli/src" "$cli/package.json" .tools/pipeline-cli/
printf '#!/bin/sh\nexec node "$(dirname "$0")/../pipeline-cli/bin/pipeline" "$@"\n' > .tools/bin/pipeline
# macOS's /usr/bin/git is an xcrun shim that writes a cache the agent's sandbox blocks, so point at the real binary.
real_git="$(xcrun --find git 2>/dev/null || command -v git)"
printf '#!/bin/sh\nexec "%s" "$@"\n' "$real_git" > .tools/bin/git
chmod +x .tools/bin/pipeline .tools/bin/git

printf '.tools/\n.pipeline/work/\n' > .gitignore
mkdir -p includes templates assets tests

cat > shop-demo.php <<'PHP'
<?php
/**
 * Plugin Name: Shop Demo
 * Version: 1.2.0
 */

defined( 'ABSPATH' ) || exit;

require __DIR__ . '/includes/shipping.php';
require __DIR__ . '/includes/checkout.php';
require __DIR__ . '/includes/orders-admin.php';

function shop_demo_footer() {
	include __DIR__ . '/templates/footer.php';
}
add_action( 'wp_footer', 'shop_demo_footer' );
PHP

cat > includes/shipping.php <<'PHP'
<?php
defined( 'ABSPATH' ) || exit;

function shop_demo_free_shipping_threshold() {
	return 50;
}

function shop_demo_qualifies_for_free_shipping( $total ) {
	return $total > shop_demo_free_shipping_threshold();
}
PHP

cat > includes/checkout.php <<'PHP'
<?php
defined( 'ABSPATH' ) || exit;

function shop_demo_checkout( WP_REST_Request $request ) {
	$cart  = get_user_meta( get_current_user_id(), 'shop_demo_cart', true );
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

cat > templates/footer.php <<'PHP'
<footer class="shop-demo-footer">
	<p>Copyright 2026 Shop Demo.</p>
</footer>
PHP

cat > assets/admin.css <<'CSS'
.shop-demo-orders .widefat td {
	padding: 8px;
}
CSS

cat > tests/test-shipping.php <<'PHP'
<?php
class Test_Shipping extends WP_UnitTestCase {
	public function test_orders_over_the_threshold_ship_free() {
		$this->assertTrue( shop_demo_qualifies_for_free_shipping( 60 ) );
		$this->assertFalse( shop_demo_qualifies_for_free_shipping( 40 ) );
	}
}
PHP

git add . && git commit -q -m "feat: initial shop demo plugin"
export PATH=".tools/bin:$PATH"
