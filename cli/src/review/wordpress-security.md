# WordPress companion

Attack classes for PHP diffs in WordPress code. Each class gives the signal to look for, the invariant the code must hold, and the test that proves it. A signal is where to look, never a finding by itself: report a finding only when you can name the boundary it crosses and what the attacker gets.

In WordPress, the lower-trust principals are a logged-out visitor, a subscriber or customer, a contributor or author acting on someone else's content, and any site that can make the browser of a logged-in user send a request.

## Nonces versus capabilities

- **Signal:** a handler that calls `wp_verify_nonce`, `check_admin_referer` or `check_ajax_referer` and then acts, with no `current_user_can` on the same path.
- **Invariant:** a nonce proves the request came from the site's own form, never who may act. Every state change checks a capability for the specific object, such as `current_user_can( 'edit_post', $post_id )`, and checks the nonce as well.
- **Test:** a subscriber with a valid nonce is denied, and a request with a missing or wrong nonce is rejected.

## REST routes and `permission_callback`

- **Signal:** `register_rest_route` with `'permission_callback' => '__return_true'`, a callback that returns true for everyone, a missing callback, or a check on `is_user_logged_in` where a capability is needed.
- **Invariant:** each route's callback returns true only for a user allowed to do what the route does. A public route reads only public data and writes nothing.
- **Test:** a logged-out request gets 401, a subscriber gets 403, and an administrator succeeds, each through `rest_do_request` or the REST server with `wp_set_current_user`.

## `nopriv` AJAX handlers

- **Signal:** `add_action( 'wp_ajax_nopriv_...' )`, or one callback hooked to both `wp_ajax_` and `wp_ajax_nopriv_`.
- **Invariant:** a `nopriv` handler is reachable by anyone, so it touches only data meant for anyone, and it never trusts a user or post id from the request.
- **Test:** a logged-out request to the action cannot read or change another user's data.

## Sanitize early, escape late

- **Signal:** `$_GET`, `$_POST`, `$_REQUEST`, `$_COOKIE`, `$_SERVER` or `get_query_var` reaching storage or output, or `echo` of a variable without `esc_html`, `esc_attr`, `esc_url`, `esc_js` or `wp_kses`.
- **Invariant:** input is unslashed and sanitized for its type where it enters, and output is escaped for its context where it leaves, even when it was sanitized on the way in.
- **Test:** a value holding `<script>` or `" onmouseover=` renders escaped in the page.

## `$wpdb->prepare` and identifiers

- **Signal:** `$wpdb->query`, `get_results`, `get_var` or `get_row` with a concatenated or interpolated variable, `prepare` with a variable in the format string, or a table or column name from input.
- **Invariant:** every value goes through a `%s`, `%d` or `%f` placeholder, every identifier through `%i` (WordPress 6.2 and later) or an allow list, and `LIKE` input through `esc_like`.
- **Test:** an input of `1 OR 1=1` or `x' -- ` matches nothing beyond its own row.

## `unserialize` on user data

- **Signal:** `unserialize` or `maybe_unserialize` on a cookie, a request value, an import file or meta a user can write.
- **Invariant:** untrusted data is decoded with `json_decode`, or `unserialize` gets `allowed_classes => false`, so no object is built from attacker input.
- **Test:** a payload holding a serialized object comes back as no object.

## Uploads

- **Signal:** `move_uploaded_file`, `wp_handle_upload` with `test_form => false` or a loose `mimes` list, a file name from input, or files written under the web root.
- **Invariant:** the type is checked against content with `wp_check_filetype_and_ext`, the name with `sanitize_file_name`, and an executable type such as `.php`, `.phtml` or an `.svg` with script never lands where it runs.
- **Test:** an upload named `shell.php.jpg` holding PHP is rejected, and a subscriber cannot upload at all when the feature is for editors.

## SSRF through `wp_remote_*`

- **Signal:** `wp_remote_get`, `wp_remote_post`, `wp_remote_request` or `download_url` on a URL from input or from an option a lower role can set.
- **Invariant:** the URL is fixed, on an allow list of hosts, or fetched with `wp_safe_remote_*`, which refuses internal and loopback addresses.
- **Test:** a URL of `http://127.0.0.1/` or `http://169.254.169.254/` is refused.

## Webhook signatures

- **Signal:** a REST route, `admin_post_nopriv_` or `woocommerce_api_` handler that receives a webhook, a signature header such as `X-Hub-Signature-256`, `hash_hmac` or `hash_equals`, or a removed signature check.
- **Invariant:** before it reads or acts on the payload, the handler computes `hash_hmac` over the raw body (`$request->get_body()` or `php://input`) with the shared secret, compares it with `hash_equals`, and rejects an event with no signature. A `==` comparison or a check that runs after the action does not count.
- **Test:** an event with a missing or wrong signature gets 401 and changes nothing, and a correctly signed event succeeds.

## API credentials

- **Signal:** an API key, token or secret written as a string literal or a `define` in plugin code, `update_option` or `add_option` storing one without autoload off, or a key in a test or fixture.
- **Invariant:** an integration credential lives in an option saved with autoload off, as in `update_option( 'acme_api_key', $key, false )`, or in a `wp-config.php` constant the plugin reads after `defined()`. Code, tests and fixtures hold placeholders only.
- **Test:** after the key is saved, `wp_load_alloptions()` does not hold it, and tests and fixtures pass with a placeholder key.

## Open redirects

- **Signal:** `wp_redirect` or `header( 'Location: ...' )` on a `redirect_to`, `return` or `url` value from the request.
- **Invariant:** redirects use `wp_safe_redirect` with `wp_validate_redirect`, so they stay on allowed hosts, and the call is followed by `exit`.
- **Test:** `redirect_to=https://evil.example` lands on the site's fallback URL.

## IDOR on post ids

- **Signal:** a `post_id`, `order_id`, `user_id` or attachment id from the request passed to `get_post`, `wp_update_post`, `update_post_meta`, `wp_delete_post` or a query.
- **Invariant:** the code checks the user may act on that object, through `current_user_can( 'edit_post', $id )` or an owner check, and checks the post type and status too.
- **Test:** an author cannot edit, read private fields of, or delete a post owned by another author.

## Role escalation through user updates

- **Signal:** `wp_update_user`, `wp_insert_user`, `update_user_meta` or `$user->set_role` with fields from the request, especially `role`, `wp_capabilities` or a meta key from input.
- **Invariant:** a user can change only an allow list of their own fields, and only a user with `promote_users` or `edit_users` for the target can change roles or another user's data.
- **Test:** a subscriber who posts `role=administrator`, or a meta key ending in `capabilities`, stays a subscriber.

## Direct file access

- **Signal:** a new PHP file under the plugin or theme that runs code at load without `defined( 'ABSPATH' ) || exit;`, or one that includes a path built from input.
- **Invariant:** every file that does work exits when loaded outside WordPress, and `include` or `require` never takes a path from input.
- **Test:** requesting the file's URL directly prints nothing and changes nothing, and a `../` path is refused.
