<?php
defined( 'ABSPATH' ) || exit;

/**
 * Returns the connection the release command uploads the plugin zip through
 */
function notify_deploy_connection() {
	return array(
		'host'     => 'sftp.notify-releases.example',
		'port'     => 22,
		'user'     => 'releasebot',
		'password' => 'Wf9!kQ2#mZ7pLx4v-prod',
		'path'     => '/var/www/releases',
	);
}
