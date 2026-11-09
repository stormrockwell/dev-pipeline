<?php
// Test fixture: one line per PHP signal

// input zone: superglobals
$value = $_GET['key'];
$value = $_POST['key'];
$value = $_REQUEST['key'];
$value = $_COOKIE['key'];
$value = $_SERVER['key'];
$value = $_FILES['key'];

// input zone: wpdb
$result = $wpdb->query("SELECT * FROM table");
$result = $wpdb->prepare("SELECT * FROM table WHERE id = %d", $id);

// authorization zone: rest route
register_rest_route('namespace', 'route', array());
add_action('rest_api_init', function() {
    register_rest_route('api', 'endpoint', array(
        'permission_callback' => array($this, 'permission_check')
    ));
});

// authorization zone: capabilities
if (current_user_can('manage_options')) {
    $can = user_can($user, 'delete_posts');
    $caps = map_meta_cap('edit_post', $user_id, $post_id);
}

// authentication zone
wp_signon(array('user_login' => $user, 'user_password' => $pass));
wp_set_auth_cookie($user_id);
wp_check_password($password, $user->user_pass);
setcookie('name', 'value');

// csrf zone: nonce
wp_ajax_nopriv_my_action();
check_ajax_referer('nonce');
wp_verify_nonce($_REQUEST['_wpnonce']);

// input zone: deserialization and execution
unserialize($data);
eval($code);
shell_exec('command');
proc_open('ls', $descriptors, $pipes);
move_uploaded_file($tmp, $destination);

// data-loss zone: destructive changes
dbDelta($sql);
$wpdb->query("DROP TABLE table_name");
$wpdb->query("TRUNCATE TABLE table_name");
register_uninstall_hook(__FILE__, 'cleanup');

// suppressions zone
// phpcs:ignore WordPress.Security
// phpcs:ignore WordPress.DB
