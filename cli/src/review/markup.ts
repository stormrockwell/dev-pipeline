import { extname } from "node:path";
import type { Hunk } from "./route.ts";

// Files whose whole job is markup or its styling.
const MARKUP_FILES = new Set([".html", ".htm", ".phtml", ".twig", ".njk", ".liquid", ".hbs", ".handlebars", ".mustache", ".ejs", ".erb", ".vue", ".svelte", ".jsx", ".tsx", ".css", ".scss", ".sass", ".less"]);
const PHP_FILES = new Set([".php", ".inc"]);
const SCRIPT_FILES = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
// Where a theme or plugin keeps the PHP that prints markup.
const TEMPLATE_DIRS = /(?:^|\/)(?:templates|template-parts|parts|views|blocks)[/]/;
// Where a front end keeps its scripts.
const FRONT_END_DIRS = /(?:^|\/)(?:assets|blocks|components|public|templates|views)[/]/;
const TAG = /<\/?[a-zA-Z][\w-]*[\s/>]/;
const TAG_IN_STRING = /['"`][^'"`]*<\/?[a-zA-Z][\w-]*[\s/>]/;
const DOM = /\binnerHTML\b|\binsertAdjacentHTML\b|\bdocument\.(?:createElement|querySelector|getElementById|body)|\.addEventListener\s*\(|\.(?:focus|blur)\s*\(|\bclassList\b|\bsetAttribute\s*\(\s*['"](?:aria-|role|tabindex)|\baria-[a-z]+|\brole=|\btabindex\b/i;

/**
 * The first changed file that writes markup, styling or front-end behavior, or null when the diff has none
 *
 * The scanner gives every PHP file a markup group, so extension alone would send each PHP fix to
 * the accessibility pass. PHP counts when it sits in a template folder or a changed line holds a
 * tag, and script files count when they sit in a front-end folder or a changed line builds markup
 * or calls the DOM.
 */
export function touchesMarkup(hunks: Hunk[]): string | null {
  for (const hunk of hunks) {
    const ext = extname(hunk.file).toLowerCase();
    if (MARKUP_FILES.has(ext)) return hunk.file;
    const changed = [...hunk.added.map((entry) => entry.text), ...hunk.removed];
    if (PHP_FILES.has(ext) && (TEMPLATE_DIRS.test(hunk.file) || changed.some((text) => TAG.test(text)))) return hunk.file;
    if (SCRIPT_FILES.has(ext) && (FRONT_END_DIRS.test(hunk.file) || changed.some((text) => TAG_IN_STRING.test(text) || DOM.test(text)))) return hunk.file;
  }
  return null;
}
