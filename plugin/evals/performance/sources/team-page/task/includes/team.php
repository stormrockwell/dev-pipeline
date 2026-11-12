<?php
defined( 'ABSPATH' ) || exit;

/**
 * Renders the team shortcode, one card per team member
 */
function team_page_render() {
	$members = get_posts(
		array(
			'post_type'      => 'team_member',
			'posts_per_page' => 50,
			'orderby'        => 'menu_order',
			'order'          => 'ASC',
			'no_found_rows'  => true,
		)
	);

	$out = '<ul class="team">';
	foreach ( $members as $member ) {
		$role = get_post_meta( $member->ID, 'role', true );
		$out .= sprintf( '<li><strong>%s</strong> %s</li>', esc_html( $member->post_title ), esc_html( $role ) );
	}
	return $out . '</ul>';
}
add_shortcode( 'team', 'team_page_render' );
