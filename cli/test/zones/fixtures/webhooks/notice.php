<?php
/**
 * Admin screen text about outbound deliveries
 */

defined( 'ABSPATH' ) || exit;

/**
 * Prints where deliveries go and the email footer
 */
function acme_render_delivery_notice() {
	$url       = get_option( 'acme_webhook_url' );
	$signature = get_option( 'acme_email_signature' );
	echo '<p>' . esc_html__( 'Webhook deliveries go to', 'acme' ) . ' ' . esc_url( $url ) . '</p>';
	echo '<p>' . esc_html( $signature ) . '</p>';
}
