# Human review zones

`pipeline scan-zones` finds the code that always gets a human reviewer, as `docs/STRATEGY.md` section 4 defines. This page documents the rules file, the built-in signal packs, the data write heuristic and the limits of all three.

## Running the scan

```
pipeline scan-zones                      # every file under the current directory
pipeline scan-zones --path <dir>         # every file under <dir>
pipeline scan-zones --staged             # lines added by the staged diff
pipeline scan-zones --range <from>..<to> # lines added between two commits
pipeline scan-zones --json               # machine-readable report
```

A file is in a zone when its path matches a path rule or when a line matches a content signal. In a diff, only added lines count for signals, and path rules apply to every changed file, including deleted ones. The scan exits 0 when it ran, because a zone is not a failure. It exits 2 for bad usage or an invalid `sensitive.yml`.

Removed lines that matched a signal are reported separately and printed first. A deleted capability check or nonce check weakens a control, so the review guide lists it before anything that was added. A removed line is matched against the signal alone, so a signal that depends on its neighbours (`near`) is skipped for removals.

Tree mode skips `vendor/`, `node_modules/`, `.git/` and the build output folders `dist/` and `build/`, which repeat their source. Diff modes still scan build output, because a plugin ships it. Tree mode reads content only from files of a scanned type. Every file still gets the path rules. Scanned types:

| Type | Extensions | Signal groups |
|---|---|---|
| PHP | `.php` `.inc` `.phtml` | `php`, `markup`, `suppressions` |
| JavaScript and TypeScript | `.js` `.jsx` `.mjs` `.cjs` `.ts` `.tsx` `.mts` `.cts` | `js`, `suppressions` |
| Stylesheets | `.css` `.scss` | `css`, `markup`, `suppressions` |
| Markup | `.html` `.htm` | `markup`, `suppressions` |
| SQL | `.sql` | `sql`, `suppressions` |

## Zones

Every rule names one of ten zones. These are the names of the `zone:*` labels in the strategy.

| Zone | Covers |
|---|---|
| `auth` | Login, sessions, cookies, JWT, OAuth, password checks |
| `authz` | Capability checks, REST permission callbacks, roles, `nopriv` handlers, Express auth middleware |
| `csrf` | Nonce creation and verification, CSRF middleware, CORS and SameSite settings |
| `input` | Request data reaching a sink: superglobals, queries, deserialization, shell, dynamic includes, uploads, outbound requests, redirects, browser sinks, and data writes from request data |
| `crypto` | Hashing, HMAC, ciphers, random bytes, key derivation |
| `secrets` | Environment files, keys, credential files, secret-bearing variables |
| `third-party` | External scripts, iframes, form targets, CSS imports |
| `privacy` | Personal data logged or exported |
| `data-loss` | Schema changes, bulk deletes, uninstall routines, destructive SQL |
| `guardrails` | `.pipeline/`, `.github/`, `.claude/`, CODEOWNERS, linter configs, dependency manifests, and security suppressions |

The 0.6 spike used the names `authentication`, `authorization`, `browser-sinks` and `suppressions`. They map to `auth`, `authz`, `input` and `guardrails`. A `sensitive.yml` that still uses an old name fails with a message that names the replacement.

## The rules file

A repo keeps its rules in `.pipeline/sensitive.yml`. Team leads own the file, and it is itself a guardrails path. Without the file, the scan uses every built-in pack. With the file, the scan uses only the rules in it plus the packs it lists.

```yaml
# Built-in rule sets to include. Names: wordpress, node. Omit the key to include none.
packs: [wordpress]

paths:
  # A bare glob puts matching files in the guardrails zone.
  - ".pipeline/**"
  # A map names another zone.
  - path: "**/billing/**"
    zone: privacy

signals:
  # The key is a group, which picks the file types the signals apply to.
  php:
    - pattern: 'charge_card\('
      zone: privacy
    - pattern: '\b(update_option|wp_update_post)\('
      zone: input
      near: '\$input\b'
    - pattern: '\b(esc_html|esc_attr)\('
      zone: input
      only: removed
      flags: i
```

### Top-level keys

| Key | Type | Meaning |
|---|---|---|
| `packs` | list of names | Built-in packs to include, from `wordpress` and `node`. |
| `paths` | list | Path rules, each a glob string or a map with `path` and `zone`. |
| `signals` | map of group to list | Content signals. Groups are `php`, `js`, `markup`, `css`, `sql` and `suppressions`. |
| `critical` | list of globs | Designated paths, where a T3 change is `risk:critical` and needs two approvals. Omit the key for `.github/**`, `.pipeline/**` and `.claude/**`, and leave it empty for none. |

Any other key is an error, so a typo does not silently disable a rule.

### Path rules

A path rule is a glob matched against the path relative to the repo root, using `/` separators and ignoring case.

| Syntax | Meaning |
|---|---|
| `*` | Any characters except `/` |
| `**/` | Zero or more directories |
| `**` | Anything, including `/` |
| `?` | One character except `/` |
| `{a,b}` | Either alternative, and `{,-lock}` allows an empty one |

A glob matches from any directory boundary, so `package.json` finds a manifest in a monorepo package and `.github/**` also finds `docs/.github/x`. A string entry gets the `guardrails` zone, and a map entry takes its `zone`.

### Signals

Each signal is a map with these keys.

| Key | Required | Meaning |
|---|---|---|
| `pattern` | yes | A JavaScript regular expression, tested against one line. |
| `zone` | yes | One of the ten zones. |
| `near` | no | A second regular expression. The signal counts only when it also matches in the same function. |
| `only` | no | `removed` makes the signal count only on removed lines, which suits a protective call such as `esc_html`. |
| `flags` | no | Any of `i`, `m` and `s`. |

Patterns are JavaScript regular expressions, so lookbehind works and PCRE-only syntax does not. An invalid pattern is an error that names the entry.

### YAML subset

The CLI has no runtime dependencies, so it reads only the YAML that the schema needs. It supports block mappings, block sequences of scalars or maps, flow sequences of scalars such as `[a, b]`, plain and quoted scalars, and `#` comments. Single-quoted strings take `''` for a quote, which keeps regular expressions with backslashes readable. It rejects anchors, tags, block scalars (`|` and `>`), flow mappings, tabs and multiple documents, and every error names the line.

## Built-in packs

The `wordpress` pack holds the spike's signals, renamed to the strategy's zones, and adds crypto, secrets, privacy and more data-loss patterns. The `node` pack covers Express middleware and routes, Next.js API routes and route handlers, auth libraries, cookies and sessions, `crypto`, `child_process`, SQL strings built from variables, and `fetch` to user-supplied URLs. Both packs carry the shared browser sink, third-party load and suppression signals, and a signal that both packs carry is listed once.

The `node` pack also covers WebCrypto, which Cloudflare Workers and browsers use in place of the Node module. `crypto.subtle.*` and `crypto.getRandomValues` are `crypto` signals. Request signing is covered two ways. The SigV4 names (`AWS4-HMAC-SHA256`, `X-Amz-Signature`, `X-Amz-Credential`, `aws4_request`) and a comparison where either side is named like a signature, HMAC or digest are `crypto` signals, and building an `Authorization` header with `headers.set`, `headers.append` or an object property is an `auth` signal. A comparison against `null`, `undefined` or an empty string is a presence check and does not count.

Helpers that belong to one repo are not in the pack. A Worker's `isAuthorized( req, env )` or `isSignatureValid` is that repo's own authorization logic, so the repo names it in its `sensitive.yml`, for example `authz` signals under `js:` with the helper names, or a path rule such as `cloudflare/**/src/**`.

Escaping and sanitizing calls (`esc_html`, `wp_kses`, `sanitize_*`, `DOMPurify`) are `only: removed` signals. Adding an escape is the safe direction, and removing one in a template is a zone signal as the strategy says.

## Data writes from untrusted input

A write is a signal under `input` only when request data reaches it. The write functions are:

| Stack | Writes |
|---|---|
| WordPress | `update_option`, `update_post_meta`, `wp_insert_post`, `wp_update_post`, `wp_update_nav_menu_item`, `wp_insert_user`, `wp_update_user` |
| Node | MongoDB driver writes (`insertOne`, `updateOne`, `replaceOne`, `bulkWrite` and the like), Prisma, Knex and Sequelize `create`, `update`, `upsert`, `insert` and `destroy`, Mongoose style `Model.create` and `Model.update`, `.save()` |

Request data is:

| Stack | Request data |
|---|---|
| WordPress | `$_GET`, `$_POST`, `$_REQUEST`, and on a `WP_REST_Request` the `get_param`, `get_params`, `get_json_params`, `get_body_params`, `get_query_params` and `get_url_params` methods, and `$request[...]` |
| Node | `req.body`, `req.query`, `req.params` (also `request.*`), `req.json()`, `formData()`, `searchParams` |

The write is flagged when request data appears in the same function or the same hunk. The scan decides the function by matching braces on lines with strings and comments blanked out, and it takes the innermost function that holds the write. A write outside any function counts request data within 20 lines on either side. In a diff, the function is found in the new file, so a write added next to an unchanged `$request->get_param()` call is still flagged, and added lines next to each other count as one hunk.

### Limits

The heuristic checks for co-occurrence, not data flow, so it errs in both directions.

- A function that reads request data for one purpose and writes unrelated constants is flagged. Reading a nonce from `$_POST` before an unrelated `update_option` is the common case.
- Request data that arrives through a parameter is missed. A helper `save( $value )` that writes its argument is not flagged, and the caller that passes `$_POST['x']` is not flagged either unless it also contains a write.
- Request data kept in a property, or read in one method and written in another, is missed.
- A closure inside a handler is its own function, so request data read in the outer function is not seen from the closure.
- Input from other channels is missed: `$_COOKIE`, `$_SERVER`, `$_FILES`, `php://input`, WordPress ability or MCP tool input, webhooks, queue messages and CLI arguments. A repo adds its own channel with a `near` pattern, such as `near: '\$input\b'` for an abilities API.
- A write through a wrapper or a custom repository class is missed, because only the listed functions and methods match.
- A mention in a comment matches like code. The scan does not strip comments, because the suppression signals live in them.
- Matching braces on a line basis can pick the wrong range in files with unusual formatting, such as several functions on one line. The 20 line window still applies outside any range found.

The security reviewer's zone call is the second layer for the cases the heuristic misses.

## Other limits

- Signals are one line at a time, so a statement split over lines can miss a pattern that spans the break.
- Test files are scanned like any other file, and so are `dist/` copies in a diff. Fixtures that plant a vulnerability will show up as zones.
- A new minified or vendored file is not yet detected as `third-party`, and the reach check for callers of changed functions is a separate task.

## Classifying a change

`pipeline classify` assigns the risk tier that `docs/STRATEGY.md` section 6 defines, using the same scan.

```
pipeline classify <file>...                # named paths, content read from the working tree
pipeline classify --staged                 # the staged diff
pipeline classify --range <from>..<to>     # the net change between two commits
pipeline classify --json ...               # machine-readable result
```

Each file gets a tier, and the change gets the highest tier of any file.

| Tier | Rule |
|---|---|
| T3 Sensitive | The file matches a path rule, has a content signal on an added line, or has a removed line that matched a signal. A guardrail path is T3 whatever its file type. |
| T2 Logic | Code and configuration of any other type, and any template that echoes variables, such as `.php`, `.phtml`, `.twig`, `.ejs`, `.hbs`, or an `.html` file that holds `<?php`, `{{`, `{%` or `<%`. |
| T1 Presentation | Stylesheets (`.css`, `.scss`), static markup, images and fonts. |
| T0 Docs | Markdown, text and reStructuredText files, and README, LICENSE and CHANGELOG. |

An empty change is T0. The output lists the tier, the zones, and the reasons that set the final tier, each with its file, line and rule (`file-type`, `template`, `path`, `zone` or `removed-signal`). The JSON also holds a `files` list with the tier of every file, so a PR split can see which files are low risk.

The classifier only raises a tier from rules. Anyone can raise a tier by hand, and only a peer reviewer, never the author, lowers a T3 task or removes a zone, so the command has no option that lowers a result. An unknown file type is T2, because rules should fail toward more review. The orchestrator and the security reviewer add the later layers that section 6 describes.
