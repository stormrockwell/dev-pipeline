import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ALLOW_FILE = ".pipeline/secrets-allow";

function globToSource(glob: string): string {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return source;
}

/**
 * Follows gitignore rules closely enough for fixtures. A pattern with no slash matches at any depth,
 * a pattern with a slash is anchored to the repo root, and a match covers everything beneath it.
 */
export function compileAllow(text: string): (path: string) => boolean {
  const expressions: RegExp[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const anchored = line.startsWith("/") || line.replace(/\/$/, "").includes("/");
    const glob = line.replace(/^\//, "").replace(/\/$/, "");
    const prefix = anchored ? "^" : "^(?:.*/)?";
    expressions.push(new RegExp(`${prefix}${globToSource(glob)}(?:/.*)?$`));
  }
  return (path) => expressions.some((expression) => expression.test(path));
}

export function loadAllow(top: string): (path: string) => boolean {
  const file = join(top, ALLOW_FILE);
  return compileAllow(existsSync(file) ? readFileSync(file, "utf8") : "");
}
