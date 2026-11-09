import { describe, expect, it } from "vitest";
import { builtinConfig } from "../../src/commands/scan-zones/config.ts";
import { scanFile, scanText } from "../../src/commands/scan-zones/scan.ts";
import type { FileInput, Zone } from "../../src/commands/scan-zones/types.ts";

const config = builtinConfig();

function zonesOf(path: string, content: string): Zone[] {
  return scanText(config, path, content).zones;
}

/** A change with its added line numbers and removed lines, as a diff would report it. */
function change(path: string, content: string, added: number[], removed: string[] = []): FileInput {
  return {
    path,
    content,
    added: new Set(added),
    removed: removed.map((text, index) => ({ line: index + 1, text })),
    deleted: false,
  };
}

describe("spike signals, one case per pattern", () => {
  // Zone names follow the strategy. The spike called these authentication, authorization and so on.
  const cases: [string, string, Zone][] = [
    ["a.php", "$value = $_GET['key'];", "input"],
    ["a.php", "$value = $_POST['key'];", "input"],
    ["a.php", "$value = $_REQUEST['key'];", "input"],
    ["a.php", "$value = $_COOKIE['key'];", "input"],
    ["a.php", "$value = $_SERVER['key'];", "input"],
    ["a.php", "$value = $_FILES['key'];", "input"],
    ["a.php", '$result = $wpdb->query("SELECT 1");', "input"],
    ["a.php", "register_rest_route('ns', '/r', []);", "authz"],
    ["a.php", "'permission_callback' => [$this, 'check'],", "authz"],
    ["a.php", "if (current_user_can('manage_options')) {", "authz"],
    ["a.php", "$ok = user_can($user, 'delete_posts');", "authz"],
    ["a.php", "$caps = map_meta_cap('edit_post', $id);", "authz"],
    ["a.php", "add_action('wp_ajax_nopriv_save', 'save');", "authz"],
    ["a.php", "wp_signon(['user_login' => $u]);", "auth"],
    ["a.php", "wp_set_auth_cookie($id);", "auth"],
    ["a.php", "wp_check_password($p, $hash);", "auth"],
    ["a.php", "setcookie('name', 'value');", "auth"],
    ["a.php", "check_ajax_referer('nonce');", "csrf"],
    ["a.php", "wp_verify_nonce($n, 'action');", "csrf"],
    ["a.php", "unserialize($data);", "input"],
    ["a.php", "eval($code);", "input"],
    ["a.php", "shell_exec('ls');", "input"],
    ["a.php", "proc_open('ls', $d, $p);", "input"],
    ["a.php", "move_uploaded_file($tmp, $dest);", "input"],
    ["a.php", "dbDelta($sql);", "data-loss"],
    ["a.php", '$wpdb->query("DROP TABLE t");', "data-loss"],
    ["a.php", '$wpdb->query("TRUNCATE t");', "data-loss"],
    ["a.php", "register_uninstall_hook(__FILE__, 'cleanup');", "data-loss"],
    ["a.js", "element.innerHTML = html;", "input"],
    ["a.js", "element.insertAdjacentHTML('beforeend', html);", "input"],
    ["a.jsx", "const c = <div dangerouslySetInnerHTML={{ __html: h }} />;", "input"],
    ["a.js", "window.postMessage({ data }, '*');", "input"],
    ["a.ts", "const fn = new Function('return 1');", "input"],
    ["a.html", '<script src="https://example.com/s.js"></script>', "third-party"],
    ["a.html", '<iframe src="https://example.com"></iframe>', "third-party"],
    ["a.html", '<form action="https://example.com/a"></form>', "third-party"],
    ["a.html", '<a href="javascript:void(0)">x</a>', "input"],
    ["a.html", '<button onclick="go()">x</button>', "input"],
    ["a.css", "body { background: url(https://example.com/a.png); }", "third-party"],
    ["a.css", '@import "other.css";', "third-party"],
    ["a.scss", "@import 'https://fonts.example.com/x';", "third-party"],
    ["a.php", "// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped", "guardrails"],
    ["a.js", "// eslint-disable-next-line no-unsanitized/property", "guardrails"],
    ["a.js", "// nosemgrep: javascript.lang.security", "guardrails"],
  ];

  it.each(cases)("%s: %s", (path, line, zone) => {
    expect(zonesOf(path, `${line}\n`)).toContain(zone);
  });

  it("covers every zone the strategy names that a signal can see", () => {
    const seen = new Set(cases.map(([, , zone]) => zone));
    for (const zone of ["auth", "authz", "csrf", "input", "third-party", "data-loss", "guardrails"] as const) {
      expect(seen.has(zone)).toBe(true);
    }
  });

  it("records the line number and the matching text", () => {
    const scan = scanText(config, "a.php", "<?php\n\n$x = $_POST['a'];\n");
    expect(scan.matches).toEqual([
      { kind: "signal", zone: "input", line: 3, pattern: "\\$_(GET|POST|REQUEST|COOKIE|SERVER|FILES)", text: "$x = $_POST['a'];" },
    ]);
  });

  it("finds a signal on consecutive lines, which a global regex with state would skip", () => {
    const scan = scanText(config, "a.php", "$a = $_GET['a'];\n$b = $_GET['b'];\n$c = $_GET['c'];\n");
    expect(scan.matches.map((match) => match.line)).toEqual([1, 2, 3]);
  });

  it("stays quiet on clean code", () => {
    expect(zonesOf("a.php", "<?php\nfunction add($a, $b) { return $a + $b; }\n")).toEqual([]);
    expect(zonesOf("a.js", "export const add = (a, b) => a + b;\n")).toEqual([]);
    expect(zonesOf("a.css", ".a { color: red; }\n")).toEqual([]);
  });

  it("scans a PHP template for markup signals", () => {
    expect(zonesOf("tpl.php", '<script src="https://cdn.example.com/x.js"></script>\n')).toContain("third-party");
  });

  it("ignores content in file types it does not scan", () => {
    expect(zonesOf("notes.md", "Use $_POST and eval( carefully.\n")).toEqual([]);
  });
});

describe("path rules", () => {
  it("assigns the zone of the rule that matched", () => {
    expect(scanText(config, "src/auth/Login.php", "").zones).toContain("auth");
    expect(scanText(config, "src/Rest/Posts.php", "").zones).toContain("authz");
    expect(scanText(config, "db/migrations/001.sql", "").zones).toContain("data-loss");
    expect(scanText(config, ".github/workflows/ci.yml", "").zones).toEqual(["guardrails"]);
    expect(scanText(config, "composer.lock", "").zones).toEqual(["guardrails"]);
    expect(scanText(config, "web/.env.local", "").zones).toEqual(["secrets"]);
    expect(scanText(config, "wp-config.php", "").zones).toContain("secrets");
    expect(scanText(config, "certs/site.pem", "").zones).toEqual(["secrets"]);
  });

  it("reports a path match without a line", () => {
    const [match] = scanText(config, ".claude/settings.json", "").matches;
    expect(match).toMatchObject({ kind: "path", zone: "guardrails", line: null });
  });

  it("matches the Node and Next.js layouts", () => {
    expect(scanText(config, "pages/api/users.ts", "").zones).toContain("input");
    expect(scanText(config, "app/api/users/route.ts", "").zones).toContain("input");
    expect(scanText(config, "middleware.ts", "").zones).toContain("authz");
    expect(scanText(config, "pnpm-lock.yaml", "").zones).toEqual(["guardrails"]);
  });
});

describe("removed signals", () => {
  it("lists a removed capability check as a weakened control", () => {
    const scan = scanFile(
      config,
      change("src/Save.php", "<?php\nfunction save() {\n  update_option('a', 1);\n}\n", [], ["  if (!current_user_can('manage_options')) return;"]),
    );
    expect(scan.removed).toEqual([
      expect.objectContaining({ zone: "authz", line: 1, text: "if (!current_user_can('manage_options')) return;" }),
    ]);
    expect(scan.zones).toContain("authz");
  });

  it("lists a removed nonce check under csrf", () => {
    const scan = scanFile(config, change("a.php", "<?php\n", [], ["check_ajax_referer('save');"]));
    expect(scan.removed.map((match) => match.zone)).toEqual(["csrf"]);
  });

  it("does not count a removed line as an added match", () => {
    const scan = scanFile(config, change("a.php", "<?php\n", [], ["$x = $_POST['a'];"]));
    expect(scan.matches).toEqual([]);
    expect(scan.removed).toHaveLength(1);
  });

  it("scans only the added lines of a changed file", () => {
    const content = "<?php\n$a = $_GET['a'];\n$b = $_GET['b'];\n";
    const scan = scanFile(config, change("a.php", content, [3]));
    expect(scan.matches.map((match) => match.line)).toEqual([3]);
  });

  it("flags a removed escaping call that an added one would not", () => {
    const removed = scanFile(config, change("tpl.php", "<?php\n", [], ["echo esc_html($title);"]));
    expect(removed.removed.map((match) => match.zone)).toEqual(["input"]);
    const added = scanText(config, "tpl.php", "echo esc_html($title);\n");
    expect(added.matches).toEqual([]);
  });

  it("flags removed sanitizing in Node", () => {
    const scan = scanFile(config, change("a.js", "\n", [], ["el.innerHTML = DOMPurify.sanitize(html);"]));
    expect(scan.removed.map((match) => match.pattern)).toContain("\\b(DOMPurify|sanitizeHtml|sanitize-html|escapeHtml)\\b");
  });

  it("reports removed lines of a deleted file", () => {
    const scan = scanFile(config, { path: "src/Gate.php", content: null, added: null, removed: [{ line: 4, text: "wp_verify_nonce($n, 'x');" }], deleted: true });
    expect(scan.removed).toEqual([expect.objectContaining({ zone: "csrf", line: 4 })]);
  });

  it("does not report a removed data write, which needs request data beside it", () => {
    const scan = scanFile(config, change("a.php", "<?php\n", [], ["update_option('a', $_POST['a']);"]));
    expect(scan.removed.map((match) => match.pattern)).not.toContain(expect.stringContaining("update_option"));
  });
});

describe("data writes from untrusted input", () => {
  const wp = (body: string) => `<?php\nfunction handler($request) {\n${body}\n}\n`;

  it.each([
    ["update_option", "update_option('mode', $_POST['mode']);"],
    ["update_post_meta", "update_post_meta($id, 'k', $_GET['v']);"],
    ["wp_insert_post", "wp_insert_post(['post_title' => $_REQUEST['t']]);"],
    ["wp_update_post", "$t = $request->get_param('title');\nwp_update_post(['ID' => $id, 'post_title' => $t]);"],
    ["wp_update_nav_menu_item", "$data = $request->get_json_params();\nwp_update_nav_menu_item($menu, 0, $data);"],
    ["wp_insert_user", "$p = $request->get_body_params();\nwp_insert_user($p);"],
    ["wp_update_user", "$p = $request->get_query_params();\nwp_update_user($p);"],
  ])("flags %s when request data reaches the write", (name, body) => {
    const scan = scanText(config, "a.php", wp(body));
    const hit = scan.matches.find((match) => match.pattern.includes("update_option") && match.text.includes(name));
    expect(hit).toMatchObject({ zone: "input" });
  });

  it.each([
    "update_option('version', '2');",
    "update_post_meta($id, 'seen', time());",
    "wp_insert_post(['post_title' => 'Welcome']);",
    "wp_update_post(['ID' => $id, 'post_status' => 'publish']);",
    "wp_update_nav_menu_item($menu, 0, $static);",
    "wp_insert_user($defaults);",
    "wp_update_user(['ID' => $id, 'role' => 'editor']);",
  ])("does not flag %s with no request data nearby", (body) => {
    expect(scanText(config, "a.php", wp(body)).matches).toEqual([]);
  });

  it("does not flag a write when the request data sits in another function", () => {
    const content = `<?php
function read() {
  return $_GET['a'];
}
function write() {
  update_option('a', 1);
}
`;
    const writes = scanText(config, "a.php", content).matches.filter((match) => match.pattern.includes("update_option"));
    expect(writes).toEqual([]);
  });

  it("does not take a WP_REST_Request type hint for request data", () => {
    const content = `<?php
function handle( \\WP_REST_Request $request ) {
  update_option( 'plugin_flag', '1' );
}
`;
    expect(scanText(config, "a.php", content).matches).toEqual([]);
  });

  it("flags a write in a class method that reads the request", () => {
    const content = `<?php
class Controller {
    public function save( WP_REST_Request $request ) {
        $value = $request->get_param( 'value' );
        update_option( 'plugin_value', $value );
    }
    public function other() {
        update_option( 'plugin_other', 1 );
    }
}
`;
    const lines = scanText(config, "a.php", content).matches.filter((match) => match.pattern.includes("update_option")).map((match) => match.line);
    expect(lines).toEqual([5]);
  });

  it("uses a window around a write that sits outside any function", () => {
    const near = "<?php\nif (isset($_POST['go'])) {\n  update_option('a', $_POST['go']);\n}\n";
    expect(scanText(config, "a.php", near).matches.some((match) => match.pattern.includes("update_option"))).toBe(true);
    const far = `<?php\nupdate_option('a', 1);\n${"// filler\n".repeat(40)}$x = $_POST['x'];\n`;
    expect(scanText(config, "a.php", far).matches.some((match) => match.pattern.includes("update_option"))).toBe(false);
  });

  it("counts request data in the same hunk of a diff", () => {
    const content = "<?php\n$v = $_POST['v'];\nupdate_option('a', $v);\n";
    const scan = scanFile(config, change("a.php", content, [2, 3]));
    expect(scan.matches.filter((match) => match.pattern.includes("update_option"))).toHaveLength(1);
  });

  it("counts request data elsewhere in the function even when the diff only adds the write", () => {
    const content = wp("  $t = $request->get_param('t');\n  update_option('a', $t);");
    const scan = scanFile(config, change("a.php", content, [4]));
    expect(scan.matches.map((match) => match.pattern.includes("update_option"))).toEqual([true]);
  });

  it("flags Node database writes that read the request body", () => {
    const content = `export async function POST(req) {
  const body = await req.json();
  await db.users.create({ data: body });
}
`;
    const scan = scanText(config, "route.ts", content);
    expect(scan.matches.some((match) => match.text.includes("db.users.create") && match.pattern.includes("prisma"))).toBe(true);
  });

  it("flags Mongo and Mongoose style writes beside req.body", () => {
    const content = `app.post('/u', async (req, res) => {
  await users.updateOne({ id: req.params.id }, { $set: req.body });
  await User.create(req.body);
});
`;
    const writes = scanText(config, "app.js", content).matches.filter((match) => /insertOne|\[A-Z\]/.test(match.pattern));
    expect(writes.map((match) => match.line)).toEqual([2, 3]);
  });

  it("does not flag a Node write with no request data in the function", () => {
    const content = `export async function seed() {
  await db.users.create({ data: { name: 'admin' } });
  await users.insertOne({ name: 'x' });
}
`;
    expect(scanText(config, "seed.js", content).matches).toEqual([]);
  });
});

describe("Node pack", () => {
  const cases: [string, string, Zone][] = [
    ["app.js", "const user = req.body.user;", "input"],
    ["app.js", "const id = req.params.id;", "input"],
    ["app.js", "const q = req.query.search;", "input"],
    ["route.ts", "export async function POST(request: Request) {", "input"],
    ["api.ts", "export default async function handler(req: NextApiRequest, res: NextApiResponse) {", "input"],
    ["app.js", "const header = req.headers.authorization;", "auth"],
    ["worker.js", "const header = req.headers.get('Authorization') || '';", "auth"],
    ["app.js", "const { exec } = require('child_process');", "input"],
    ["app.js", "execSync(`git log ${ref}`);", "input"],
    ["app.js", "spawn('ls', [dir]);", "input"],
    ["app.js", "const out = eval(code);", "input"],
    ["app.js", "res.redirect(req.query.next);", "input"],
    ["app.js", "await prisma.$queryRawUnsafe(sql);", "input"],
    ["app.js", "const q = `SELECT * FROM users WHERE id = ${id}`;", "input"],
    ["app.js", "const q = 'SELECT * FROM users WHERE id = ' + id;", "input"],
    ["app.js", "const r = await fetch(req.body.url);", "input"],
    ["app.js", "app.use(passport.initialize());", "auth"],
    ["app.js", "const token = jwt.sign({ id }, secret);", "auth"],
    ["app.js", "res.cookie('sid', id, { httpOnly: true });", "auth"],
    ["app.js", "app.use(session({ secret }));\nreq.session.user = u;", "auth"],
    ["auth.ts", "import { getServerSession } from 'next-auth';", "auth"],
    ["app.js", "app.use('/admin', requireAuth);", "authz"],
    ["app.js", "if (!hasRole(user, 'admin')) return res.sendStatus(403);", "authz"],
    ["app.js", "function guard(req, res, next) {", "authz"],
    ["app.js", "app.use(csurf());", "csrf"],
    ["app.js", "app.use(cors({ origin: '*', credentials: true }));", "csrf"],
    ["app.js", "res.cookie('a', b, { sameSite: 'none' });", "csrf"],
    ["app.js", "const h = crypto.createHash('sha256');", "crypto"],
    ["app.js", "import { createHmac } from 'node:crypto';", "crypto"],
    ["app.js", "const key = crypto.randomBytes(32);", "crypto"],
    ["app.js", "const secret = process.env.SESSION_SECRET;", "secrets"],
    ["app.js", "logger.info(`signup ${email}`, email);", "privacy"],
    ["app.js", "await Model.deleteMany({});", "data-loss"],
  ];

  it.each(cases)("%s: %s", (path, line, zone) => {
    expect(zonesOf(path, `${line}\n`)).toContain(zone);
  });

  it("flags fetch of a variable URL only beside request data", () => {
    const hit = `async function proxy(req, res) {\n  const target = req.query.url;\n  const r = await fetch(target);\n}\n`;
    expect(scanText(config, "a.js", hit).matches.some((match) => match.text.includes("fetch(target)") && match.pattern.includes("A-Za-z_$"))).toBe(true);
    const clean = `async function load() {\n  const r = await fetch(endpoint);\n}\n`;
    expect(scanText(config, "a.js", clean).matches).toEqual([]);
  });

  it("does not take a regular expression exec for child_process", () => {
    expect(zonesOf("a.js", "const m = /a(b)/.exec(text);\n")).toEqual([]);
  });

  it("does not treat a plain header read as a control", () => {
    expect(zonesOf("a.js", "const accept = req.headers.get('Accept') || '';\n")).toEqual([]);
  });

  it("stays quiet on a constant query string", () => {
    expect(zonesOf("a.js", "const q = 'SELECT 1';\n")).toEqual([]);
  });
});

describe("the WordPress pack beyond the spike", () => {
  const cases: [string, Zone][] = [
    ["$h = hash_hmac('sha256', $data, $key);", "crypto"],
    ["$p = wp_hash_password($plain);", "crypto"],
    ["define('AUTH_KEY', 'x');", "secrets"],
    ["add_filter('wp_privacy_personal_data_exporters', 'x');", "privacy"],
    ["wp_delete_post($id, true);", "data-loss"],
    ["wp_safe_redirect($url);", "input"],
    ["include $file;", "input"],
    ["check_admin_referer('save');", "csrf"],
  ];
  it.each(cases)("%s", (line, zone) => {
    expect(zonesOf("a.php", `${line}\n`)).toContain(zone);
  });
});

describe("SQL files", () => {
  it("flags destructive statements in a migration", () => {
    expect(zonesOf("db/up.sql", "drop table tenants;\n")).toContain("data-loss");
    expect(zonesOf("db/up.sql", "ALTER TABLE t DROP COLUMN c;\n")).toContain("data-loss");
    expect(zonesOf("db/up.sql", "DELETE FROM sessions;\n")).toContain("data-loss");
  });

  it("leaves additive statements alone", () => {
    expect(zonesOf("db/up.sql", "CREATE TABLE t (id INT);\nALTER TABLE t ADD COLUMN c INT;\n")).toEqual([]);
  });
});

describe("precision", () => {
  it("does not read a method declaration named fetch as an outbound request", () => {
    const content = "export default {\n  async fetch(req, env) {\n    const q = req.query.a;\n    return new Response(q);\n  },\n};\n";
    expect(scanText(config, "worker.js", content).matches.every((match) => !match.pattern.includes("fetch"))).toBe(true);
  });
});
