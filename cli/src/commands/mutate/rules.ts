/**
 * One way of disabling a security check on a single line
 */
export interface Mutant {
  file: string;
  line: number;
  check: string;
  mutation: string;
  original: string;
  mutated: string;
}

type Stack = "php" | "js";

const PHP_FILE = /\.php$/i;
const JS_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

// A middleware stands in for a request handler, so a boolean in its place would crash at load and kill the mutant for the wrong reason.
const NOOP_MIDDLEWARE = "((req, res, next) => next())";

const PHP_CHECKS: { name: string; to: string }[] = [
  { name: "current_user_can", to: "true" },
  { name: "user_can", to: "true" },
  { name: "wp_verify_nonce", to: "1" },
  { name: "check_ajax_referer", to: "1" },
  { name: "check_admin_referer", to: "1" },
];

const JS_PREDICATES = ["isAuthenticated", "hasRole", "hasPermission", "checkPermission", "isAdmin"];

const JS_MIDDLEWARE = ["requireAuth", "requireRole", "ensureLoggedIn", "authorize"];

const JS_BARE_MIDDLEWARE = ["requireAuth", "ensureLoggedIn", "isAuthenticated"];

const ROUTE_CALL = /\b(?:app|router)\.(?:use|get|post|put|patch|delete|all)\(/;

const NOT_SIGNED_IN = /!\s*(?:(?:req|request)\.session\.user|(?:req|request)\.user|session\.user)\b(?![\w$.(])/g;

export const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#)/;

const GUARD_STATEMENT = /^\s*(?:wp_die\(|wp_send_json_error\(|return\b|throw\b|exit\b|die\b)/;

/**
 * The stack a path belongs to, or null for a file the mutator leaves alone
 */
export function stackOf(path: string): Stack | null {
  if (PHP_FILE.test(path)) return "php";
  return JS_FILE.test(path) ? "js" : null;
}

/**
 * The index just past the bracket that closes the one opening at `open`, or -1 when the line ends first
 *
 * Quotes are skipped so a bracket inside a string does not count.
 */
export function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text[i]!;
    if (char === "'" || char === '"' || char === "`") {
      for (i++; i < text.length && text[i] !== char; i++) if (text[i] === "\\") i++;
    } else if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The index where a value ends, at the first top-level comma or closing bracket, or the line's end
 */
function valueEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const char = text[i]!;
    if (char === "'" || char === '"' || char === "`") {
      for (i++; i < text.length && text[i] !== char; i++) if (text[i] === "\\") i++;
    } else if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (char === "," && depth === 0) return i;
  }
  return text.length;
}

interface Span {
  start: number;
  end: number;
  name: string;
}

/**
 * The calls to a function on a line, receiver chain included for JS, skipping definitions
 *
 * A call whose parentheses do not close on the line is left out, because the mutator works one line at a time.
 */
function calls(text: string, names: string[], stack: Stack): Span[] {
  const spans: Span[] = [];
  const receiver = stack === "js" ? "(?:[\\w$]+(?:\\?)?\\.)*" : "";
  const lookbehind = stack === "php" ? "(?<![\\w$>:\\\\])" : "(?<![\\w$])";
  for (const name of names) {
    const pattern = new RegExp(`${lookbehind}${receiver}${name}\\s*\\(`, "g");
    for (const match of text.matchAll(pattern)) {
      if (/\bfunction\s+&?$/.test(text.slice(0, match.index))) continue;
      const open = match.index + match[0].length - 1;
      const end = closeOf(text, open);
      if (end !== -1) spans.push({ start: match.index, end, name });
    }
  }
  return spans;
}

function replaceSpan(text: string, start: number, end: number, to: string): string {
  return `${text.slice(0, start)}${to}${text.slice(end)}`;
}

function mutant(file: string, line: number, check: string, mutation: string, original: string, mutated: string): Mutant {
  return { file, line, check, mutation, original, mutated };
}

/**
 * Whether a line is a security condition that opens a block, such as `if ( ! current_user_can( 'x' ) ) {`
 */
function opensGuardedBlock(text: string): boolean {
  return /^\s*(?:\}\s*)?(?:else\s*)?if\s*\(.*\)\s*\{\s*$/.test(text);
}

/**
 * The mutants that disable a security check on one line
 *
 * Each call to a known check becomes the value that lets everything through, a `permission_callback`
 * becomes `__return_true`, and a signed-in test becomes false. A guard statement that an unmutable
 * security condition opens is removed, which `guardOf` handles from the line above.
 */
export function mutantsOf(file: string, lineNumber: number, text: string): Mutant[] {
  const stack = stackOf(file);
  if (stack === null || text.length > 4000 || COMMENT_LINE.test(text)) return [];
  const out: Mutant[] = [];
  const add = (check: string, mutation: string, mutated: string) => out.push(mutant(file, lineNumber, check, mutation, text, mutated));

  if (stack === "php") {
    for (const span of calls(text, PHP_CHECKS.map((entry) => entry.name), "php")) {
      const to = PHP_CHECKS.find((entry) => entry.name === span.name)!.to;
      add(`${span.name}()`, `replace the call with ${to}`, replaceSpan(text, span.start, span.end, to));
    }
    for (const match of text.matchAll(/(['"]permission_callback['"]\s*=>\s*)/g)) {
      const start = match.index + match[0].length;
      const end = valueEnd(text, start);
      if (end > start) add("permission_callback", "return true for every request", replaceSpan(text, start, end, "'__return_true'"));
    }
    return out;
  }

  for (const span of calls(text, JS_PREDICATES, "js")) {
    add(`${span.name}()`, "replace the call with true", replaceSpan(text, span.start, span.end, "true"));
  }
  for (const span of calls(text, JS_MIDDLEWARE, "js")) {
    add(`${span.name}()`, "replace the middleware with one that calls next", replaceSpan(text, span.start, span.end, NOOP_MIDDLEWARE));
  }
  for (const match of text.matchAll(NOT_SIGNED_IN)) {
    add(match[0].replace(/^!\s*/, "!"), "treat every request as signed in", replaceSpan(text, match.index, match.index + match[0].length, "false"));
  }
  if (ROUTE_CALL.test(text) && !/^\s*(?:import|export)\b/.test(text)) {
    for (const name of JS_BARE_MIDDLEWARE) {
      for (const match of text.matchAll(new RegExp(`(?<![\\w$.])${name}\\b(?!\\s*\\()`, "g"))) {
        add(name, "replace the middleware with one that calls next", replaceSpan(text, match.index, match.index + name.length, NOOP_MIDDLEWARE));
      }
    }
  }
  return out;
}

/**
 * Whether every bracket on a line closes on it, so dropping the line leaves valid code behind
 */
function balanced(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "'" || char === '"' || char === "`") {
      for (i++; i < text.length && text[i] !== char; i++) if (text[i] === "\\") i++;
    } else if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
  }
  return depth === 0;
}

/**
 * The mutant that removes a guard statement opened by a security condition the line rules cannot mutate
 *
 * `above` is the nearest non-blank line before the statement.
 */
export function guardOf(file: string, lineNumber: number, text: string, above: string): Mutant | null {
  if (stackOf(file) === null || !GUARD_STATEMENT.test(text) || !text.trimEnd().endsWith(";") || !balanced(text) || !opensGuardedBlock(above)) return null;
  const indent = /^\s*/.exec(text)![0];
  return mutant(file, lineNumber, `guard ${text.trim()}`, "remove the guard statement", text, indent);
}
