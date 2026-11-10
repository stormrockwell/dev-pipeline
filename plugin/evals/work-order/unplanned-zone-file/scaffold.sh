#!/usr/bin/env bash
# Seeds the shop fixture, then puts this case's work order and branch in place.
# The harness resolves symlinks, so this is a real file that sources the shared fixture.
set -euo pipefail
. "$(dirname "$0")/../fixtures/shop.sh"
git checkout -q -b feat/orders-filter
mkdir -p .pipeline/work/orders-filter
cat > .pipeline/work/orders-filter/work-order.md <<'MD'
---
title: Filter the orders admin table by status
level: confirm
tasks:
  - id: 1
    title: Status filter dropdown
    files: [templates/orders-filter.php, assets/admin.css]
    tier: T2
    zones: []
---

## Task 1: Status filter dropdown
A dropdown above the orders table that filters by order status.
MD
pipeline schedule .pipeline/work/orders-filter/work-order.md > /dev/null
cat > templates/orders-filter.php <<'PHP'
<select name="status" class="shop-demo-filter">
	<option value="">All</option>
	<option value="publish">Paid</option>
</select>
PHP
cat >> assets/admin.css <<'CSS'
.shop-demo-filter {
	margin: 8px 0;
}
CSS
cat > includes/orders-admin.php <<'PHP'
<?php
defined( 'ABSPATH' ) || exit;

function shop_demo_orders_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$status = $_GET['status'];
	$orders = get_posts( array( 'post_type' => 'shop_order', 'numberposts' => 50, 'post_status' => $status ) );
	include __DIR__ . '/../templates/orders-filter.php';
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
git add . && git commit -q -m "feat: filter orders by status"
