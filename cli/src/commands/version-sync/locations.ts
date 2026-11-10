import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One place a version string lives
 */
export interface Location {
  file: string;
  line: number;
  kind: string;
  version: string;
}

// A WordPress header line, inside a docblock or a CSS comment.
const HEADER_VERSION = /^([\t /*#@]*Version:[\t ]*)(\S+)/m;
const STABLE_TAG = /^(Stable tag:[\t ]*)(\S+)/im;
const DEFINE_VERSION = /(define\(\s*['"]([A-Z0-9_]*VERSION)['"]\s*,\s*['"])([^'"]+)(['"])/g;
const CONST_VERSION = /(\bconst\s+([A-Z0-9_]*VERSION)\s*=\s*['"])([^'"]+)(['"])/g;
const JSON_VERSION = /^(\s*"version"\s*:\s*")([^"]+)(")/m;

// Headers sit at the top of the file, so a long file is read only that far for the check.
const HEADER_BYTES = 8192;

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function read(dir: string, file: string): string | null {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * The PHP files at the repo root that carry a plugin header
 */
function pluginFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".php"))
    .sort()
    .filter((name) => /^[\t /*#@]*Plugin Name:/m.test((read(dir, name) ?? "").slice(0, HEADER_BYTES)));
}

function constants(file: string, text: string): Location[] {
  const found: Location[] = [];
  for (const pattern of [DEFINE_VERSION, CONST_VERSION]) {
    for (const match of text.matchAll(pattern)) {
      found.push({ file, line: lineOf(text, match.index), kind: `constant ${match[2]}`, version: match[3]! });
    }
  }
  return found;
}

/**
 * Every place a version string lives: plugin and theme headers, their version constants, the readme
 * stable tag, and the version in package.json and composer.json
 *
 * A readme whose stable tag is `trunk` holds no version, so it stays out.
 */
export function findLocations(dir: string): Location[] {
  const found: Location[] = [];
  for (const file of pluginFiles(dir)) {
    const text = read(dir, file)!;
    const header = HEADER_VERSION.exec(text.slice(0, HEADER_BYTES));
    if (header) found.push({ file, line: lineOf(text, header.index), kind: "plugin header", version: header[2]! });
    found.push(...constants(file, text));
  }
  const style = read(dir, "style.css");
  if (style !== null && /Theme Name:/.test(style.slice(0, HEADER_BYTES))) {
    const header = HEADER_VERSION.exec(style.slice(0, HEADER_BYTES));
    if (header) found.push({ file: "style.css", line: lineOf(style, header.index), kind: "theme header", version: header[2]! });
    const functions = read(dir, "functions.php");
    if (functions !== null) found.push(...constants("functions.php", functions));
  }
  const readme = read(dir, "readme.txt");
  const tag = readme === null ? null : STABLE_TAG.exec(readme);
  if (tag && tag[2]!.toLowerCase() !== "trunk") found.push({ file: "readme.txt", line: lineOf(readme!, tag.index), kind: "readme stable tag", version: tag[2]! });
  for (const file of ["package.json", "composer.json"]) {
    const text = read(dir, file);
    const match = text === null ? null : JSON_VERSION.exec(text);
    if (match) found.push({ file, line: lineOf(text!, match.index), kind: `${file} version`, version: match[2]! });
  }
  return found;
}

/**
 * Rewrites every location to one version, touching only the version text
 */
export function setVersion(dir: string, version: string): Location[] {
  const locations = findLocations(dir);
  for (const file of [...new Set(locations.map((location) => location.file))]) {
    const path = join(dir, file);
    let text = readFileSync(path, "utf8");
    if (file.endsWith(".json")) {
      text = text.replace(JSON_VERSION, `$1${version}$3`);
    } else if (file === "readme.txt") {
      text = text.replace(STABLE_TAG, `$1${version}`);
    } else {
      if (locations.some((location) => location.file === file && location.kind.endsWith("header"))) {
        const head = text.slice(0, HEADER_BYTES).replace(HEADER_VERSION, `$1${version}`);
        text = head + text.slice(HEADER_BYTES);
      }
      text = text.replace(DEFINE_VERSION, `$1${version}$4`).replace(CONST_VERSION, `$1${version}$4`);
    }
    writeFileSync(path, text);
  }
  return findLocations(dir);
}
