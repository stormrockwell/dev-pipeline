#!/usr/bin/env bash
# Builds a disposable mini WordPress site containing a copy of the pilot plugin.
# Usage: make-copy.sh <dest> [per-copy-db]
# The plugin tests derive ABSPATH from dirname(__DIR__, 4), so the copy has to sit
# inside a site root. wp-admin and wp-includes are APFS clones, vendor is a clone.
set -euo pipefail
SITE=/Users/storm/Studio/media-made-easy
PLUGIN=$SITE/wp-content/plugins/media-on-autopilot
DEST=$1
MODE=${2:-}
rm -rf "$DEST"
mkdir -p "$DEST/wp-content/plugins" "$DEST/wp-content/mu-plugins" "$DEST/wp-content/database"
cp -c "$SITE"/*.php "$DEST"/
cp -cR "$SITE/wp-admin" "$SITE/wp-includes" "$DEST"/
cp -c "$SITE/wp-content/db.php" "$SITE/wp-content/index.php" "$DEST/wp-content/"
cp -cR "$SITE/wp-content/mu-plugins/sqlite-database-integration" "$DEST/wp-content/mu-plugins/"
P=$DEST/wp-content/plugins/media-on-autopilot
mkdir -p "$P"
for f in src tests build assets media-on-autopilot.php composer.json composer.lock phpunit.xml.dist phpunit-integration.xml.dist phpcs.xml.dist; do
  cp -R "$PLUGIN/$f" "$P/"
done
cp -cR "$PLUGIN/vendor" "$P/vendor"
if [ "$MODE" = "per-copy-db" ]; then
  # Derive the SQLite dir from an env var, falling back to the original path.
  sed -i '' "s#define( 'DB_DIR', sys_get_temp_dir() . '/moap-wp-tests/' );#define( 'DB_DIR', ( getenv( 'MOAP_DB_DIR' ) ?: sys_get_temp_dir() . '/moap-wp-tests' ) . '/' );#" "$P/tests/wp-tests-config.php"
  sed -i '' "s#\$moap_test_db_dir = sys_get_temp_dir() . '/moap-wp-tests/';#\$moap_test_db_dir = ( getenv( 'MOAP_DB_DIR' ) ?: sys_get_temp_dir() . '/moap-wp-tests' ) . '/';#" "$P/tests/bootstrap-integration.php"
  grep -n MOAP_DB_DIR "$P/tests/wp-tests-config.php" "$P/tests/bootstrap-integration.php"
fi
