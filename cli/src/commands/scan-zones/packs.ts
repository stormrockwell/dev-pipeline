import type { Group, PathRule, Signal, Zone } from "./types.ts";

export interface Pack {
  name: string;
  paths: PathRule[];
  signals: Signal[];
}

function paths(zone: Zone, ...globs: string[]): PathRule[] {
  return globs.map((glob) => ({ glob, zone }));
}

function signals(group: Group, zone: Zone, ...patterns: string[]): Signal[] {
  return patterns.map((pattern) => ({ group, zone, pattern }));
}

/** Request data in the same function, which is what makes a data write an input risk. */
const wpRequest =
  "\\$_(GET|POST|REQUEST)\\b|->get_(json_|body_|query_|url_)?params?\\(|\\$request\\[";

const nodeRequest =
  "\\b(req|request)\\.(body|query|params)\\b|\\b(req|request)\\.json\\(|\\bformData\\(|\\bsearchParams\\b";

function near(group: Group, zone: Zone, pattern: string, request: string): Signal {
  return { group, zone, pattern, near: request };
}

function removedOnly(group: Group, zone: Zone, pattern: string): Signal {
  return { group, zone, pattern, only: "removed" };
}

/** Browser sinks, third-party loads and suppressions apply to both stacks, so each pack carries them. */
const shared: Signal[] = [
  ...signals("js", "input", "innerHTML|insertAdjacentHTML|dangerouslySetInnerHTML", "postMessage|new Function"),
  ...signals("markup", "third-party", "<script[^>]+src=[\"']https?://", "<iframe|<form[^>]+action=[\"']https?://"),
  ...signals("markup", "input", "javascript:|\\son[a-z]+="),
  ...signals("css", "third-party", "url\\([\"']?https?://|@import"),
  {
    group: "sql",
    zone: "data-loss",
    pattern: "\\b(DROP\\s+(TABLE|DATABASE|COLUMN|INDEX)|TRUNCATE|DELETE\\s+FROM)\\b|\\bALTER\\s+TABLE\\b.*\\bDROP\\b",
    flags: "i",
  },
  ...signals(
    "suppressions",
    "guardrails",
    "phpcs:ignore.*WordPress\\.(Security|DB)",
    "eslint-disable.*no-unsanitized",
    "nosemgrep",
  ),
];

const sharedPaths: PathRule[] = [
  ...paths("guardrails", ".github/**", ".claude/**", ".pipeline/**", "**/CODEOWNERS"),
  ...paths("auth", "**/auth/**"),
  ...paths("authz", "**/*permission*"),
  ...paths("data-loss", "**/migrations/**"),
  ...paths("secrets", "**/.env*", "**/*.{pem,key,p12}", "**/auth.json"),
];

export const wordpress: Pack = {
  name: "wordpress",
  paths: [
    ...sharedPaths,
    ...paths("authz", "**/rest/**"),
    ...paths("guardrails", "composer.{json,lock}", "package{,-lock}.json", "**/.htaccess", "**/phpcs.xml*", "**/phpstan*.neon*"),
    ...paths("secrets", "**/wp-config*.php"),
  ],
  signals: [
    ...signals("php", "input", "\\$_(GET|POST|REQUEST|COOKIE|SERVER|FILES)", "\\$wpdb->"),
    ...signals("php", "authz", "register_rest_route|permission_callback", "current_user_can|user_can|map_meta_cap", "wp_ajax_nopriv_"),
    ...signals("php", "auth", "wp_signon|wp_set_auth_cookie|wp_check_password|setcookie"),
    ...signals("php", "csrf", "check_ajax_referer|wp_verify_nonce|check_admin_referer|wp_create_nonce|wp_nonce_field"),
    ...signals("php", "input", "unserialize|eval\\(|shell_exec|proc_open|move_uploaded_file", "\\b(passthru|popen|system)\\("),
    ...signals("php", "input", "wp_redirect|wp_safe_redirect", "\\b(include|require)(_once)?\\b\\s*\\(?\\s*\\$"),
    ...signals("php", "data-loss", "dbDelta|DROP TABLE|TRUNCATE|register_uninstall_hook", "wp_delete_(post|user|attachment|term)\\(|delete_option\\("),
    ...signals("php", "crypto", "hash_hmac|wp_salt\\(|openssl_|sodium_|password_hash|password_verify|wp_hash_password"),
    ...signals("php", "secrets", "\\b(AUTH|SECURE_AUTH|LOGGED_IN|NONCE)_(KEY|SALT)\\b"),
    ...signals("php", "privacy", "wp_privacy_|error_log\\(.*(email|password|phone)"),
    near(
      "php",
      "input",
      "\\b(update_option|update_post_meta|wp_insert_post|wp_update_post|wp_update_nav_menu_item|wp_insert_user|wp_update_user)\\(",
      wpRequest,
    ),
    near("php", "input", "\\b(wp_remote_(get|post|request|head)|wp_safe_remote_\\w+|curl_init|file_get_contents)\\(", wpRequest),
    removedOnly("php", "input", "\\b(esc_(html|attr|url|js|textarea)|wp_kses(_post)?|sanitize_\\w+|absint|esc_sql)\\("),
    ...shared,
  ],
};

const signatureName = "(?:\\w*(?:signature|hmac|digest)\\w*|sig)";

/** The lookahead keeps `\s*` from backing off, and `(?!=)` keeps `==` from matching inside `===`. */
const operator = "(?:===?|!==?)(?!=)\\s*(?=\\S)";

/** A comparison against null, undefined or an empty string is a presence check, not a signature check. */
const notAbsent = "(?!null\\b|undefined\\b|['\"]{2})";

/** Either side of a loose or strict comparison names a signature. */
const signatureComparison = [
  `\\b${signatureName}\\s*${operator}${notAbsent}\\S`,
  `${operator}${notAbsent}[\\w.$]*(?:signature|hmac|digest)\\w*\\b`,
  `${operator}${notAbsent}(?:\\w+\\.)*sig\\b`,
].join("|");

/**
 * A header set call, or an object property whose value is a template, a call, a scheme such as Bearer, or a
 * variable. A bare string, as in a name map, and a TypeScript type are not matches.
 */
const authorizationHeaderBuilt = [
  "\\bheaders\\.(set|append)\\(\\s*['\"]authorization['\"]",
  "['\"]?\\bauthorization['\"]?\\s*:\\s*(?:`|['\"](?:Bearer|Basic|Digest|Token|Hmac|Signature|AWS4)|[\\w$.]+\\()",
  "['\"]?\\bauthorization['\"]?\\s*:\\s*(?!(?:string|number|boolean|any|unknown|undefined|null)\\b)[A-Za-z_$][\\w$.]*\\s*[,}]",
].join("|");

export const node: Pack = {
  name: "node",
  paths: [
    ...sharedPaths,
    ...paths("authz", "**/middleware.{js,ts,mjs}"),
    ...paths("input", "**/pages/api/**", "**/app/**/route.{js,ts,mjs}"),
    ...paths(
      "guardrails",
      "package{,-lock}.json",
      "**/{pnpm-lock.yaml,yarn.lock,.npmrc}",
      "**/.eslintrc*",
      "**/eslint.config.*",
    ),
  ],
  signals: [
    // Express routes and Next.js handlers are the places where request data enters.
    ...signals(
      "js",
      "input",
      "\\b(req|request)\\.(body|query|params)\\b",
      "export\\s+(async\\s+)?function\\s+(GET|POST|PUT|PATCH|DELETE)\\b",
      "export\\s+default\\s+(async\\s+)?function\\s+handler\\b|\\b(NextApiRequest|NextRequest)\\b",
      "\\b(execSync|spawnSync|execFile(Sync)?)\\(|\\bchild_process\\b|(?<![.\\w])(exec|spawn|fork)\\(",
      "\\beval\\(|\\bvm\\.(runIn\\w+|Script)\\b|\\bres\\.redirect\\(|(?<![.\\w])redirect\\(",
      "\\$(query|execute)RawUnsafe|\\bsequelize\\.query\\(|\\bknex\\.raw\\(",
      "(SELECT|INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\b[^`'\"]*['\"`]\\s*\\+|`[^`]*\\b(SELECT|INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\b[^`]*\\$\\{",
      "\\b(fetch|axios(\\.\\w+)?|got|http\\.get|https\\.get)\\(\\s*(req|request)\\.(body|query|params)\\b",
    ),
    // The lookbehind keeps a method named fetch(req, env) from reading as a call.
    near("js", "input", "(?<!\\b(?:async|function)\\s+)\\b(fetch|axios(\\.\\w+)?|got)\\(\\s*[A-Za-z_$]", nodeRequest),
    near("js", "input", "\\.(insertOne|insertMany|updateOne|updateMany|replaceOne|findOneAndUpdate|findByIdAndUpdate|bulkWrite|bulkCreate|upsert)\\(", nodeRequest),
    near("js", "input", "\\b(prisma|db|knex|sequelize)\\b[\\w.$]*\\.(create|createMany|update|updateMany|upsert|insert|destroy|delete|deleteMany)\\(", nodeRequest),
    near("js", "input", "\\b[A-Z]\\w*\\.(create|update|destroy)\\(|\\bknex\\([^)]*\\)\\.(insert|update|del)\\(|\\.save\\(", nodeRequest),
    ...signals(
      "js",
      "auth",
      "\\b(passport|jsonwebtoken|bcrypt(js)?|argon2|next-auth|express-session|cookie-session|lucia|iron-session)\\b",
      "\\bjwt\\.(sign|verify|decode)\\(|\\bjose\\b",
      "\\bgetServerSession\\(|\\breq\\.session\\b|\\bres\\.cookie\\(|\\bclearCookie\\(|\\bcookies\\(\\)\\.(set|delete)|Set-Cookie",
    ),
    ...signals(
      "js",
      "authz",
      "\\b(requireAuth|isAuthenticated|ensureLoggedIn|authorize|hasRole|hasPermission|checkPermission|requireRole|isAdmin)\\b",
      "\\breq\\.user\\b|\\bsession\\.user\\b",
      "\\b(app|router)\\.use\\([^)]*\\b(auth|admin|role|permission)",
      "\\(\\s*(req|request)\\s*,\\s*res\\s*,\\s*next\\s*\\)",
    ),
    ...signals("js", "csrf", "\\b(csurf|csrf|xsrf)\\b|\\bsameSite\\b|\\bcors\\(|Access-Control-Allow-Origin|\\bcredentials:\\s*true"),
    ...signals(
      "js",
      "crypto",
      "\\bcrypto\\.(createHash|createHmac|createCipher\\w*|createDecipher\\w*|randomBytes|pbkdf2\\w*|scrypt\\w*|sign|verify|timingSafeEqual|createSign|createVerify)\\(",
      "require\\(['\"](node:)?crypto['\"]\\)|from ['\"](node:)?crypto['\"]",
      "createHash\\(['\"](md5|sha1)['\"]\\)",
    ),
    // WebCrypto is what Cloudflare Workers and browsers use, and it has no `require('crypto')` line to catch.
    ...signals("js", "crypto", "\\bcrypto\\.(subtle\\b|getRandomValues\\()"),
    // Request signing, such as SigV4: the algorithm names, and a comparison that decides whether a signature is valid.
    { group: "js", zone: "crypto", pattern: "AWS4-HMAC-SHA256|\\bX-Amz-(Signature|Credential|SignedHeaders)\\b|\\baws4_request\\b", flags: "i" },
    { group: "js", zone: "crypto", pattern: signatureComparison, flags: "i" },
    // Building an Authorization header is the outbound half of authentication, which a read of `req.headers` does not cover.
    { group: "js", zone: "auth", pattern: authorizationHeaderBuilt, flags: "i" },
    ...signals("js", "secrets", "\\bprocess\\.env\\.\\w*(SECRET|KEY|TOKEN|PASSWORD|PASSWD|CREDENTIAL)\\w*"),
    ...signals("js", "privacy", "\\b(console\\.(log|info|debug)|logger\\.\\w+)\\(.*\\b(email|password|phone|ssn|dob)\\b"),
    ...signals("js", "data-loss", "\\b(DROP\\s+TABLE|TRUNCATE\\s+TABLE|deleteMany|dropDatabase|dropCollection)\\b", "\\.(destroy|drop)\\(\\{?\\s*(truncate|where:\\s*\\{\\s*\\})"),
    {
      group: "js",
      zone: "auth",
      pattern: "\\b(req|request)\\.headers(\\.|\\[|\\.get\\()\\s*['\"]?(authorization|x-api-key|cookie)\\b",
      flags: "i",
    },
    removedOnly("js", "input", "\\b(DOMPurify|sanitizeHtml|sanitize-html|escapeHtml)\\b"),
    ...shared,
  ],
};

export const packs: Record<string, Pack> = { wordpress, node };
