#!/usr/bin/env bash
set -euo pipefail
git init -q -b main
git config user.email spike@example.com
git config user.name Spike
mkdir -p templates
cat > demo-plugin.php <<'PHP'
<?php
/**
 * Plugin Name: Demo Plugin
 */

function demo_render_search() {
	include __DIR__ . '/templates/search.php';
}
add_shortcode( 'demo_search', 'demo_render_search' );
PHP
cat > templates/search.php <<'PHP'
<form method="get">
	<input type="search" name="q" value="">
</form>
PHP
git add . && git commit -q -m "feat: initial plugin"
cat >> templates/search.php <<'PHP'
<?php if ( isset( $_GET['q'] ) ) : ?>
	<p>Results for: <?php echo $_GET['q']; ?></p>
<?php endif; ?>
PHP
git commit -q -am "feat: show search term in results"
