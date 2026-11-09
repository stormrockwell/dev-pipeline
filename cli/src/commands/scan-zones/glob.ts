/** Escapes a character that is special in a regular expression. */
function escape(char: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(char) ? `\\${char}` : char;
}

/**
 * Translates a glob into a regular expression. A glob matches from any directory boundary, so a bare
 * `package.json` finds the manifest in a monorepo package, and matching ignores case because a class
 * named PermissionPolicy is the file the rule `*permission*` exists to catch. A caller that needs
 * exact case, such as the test path list where `*Test.php` must not match `latest.php`, passes false.
 */
export function globToRegExp(glob: string, ignoreCase = true): RegExp {
  let source = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      depth++;
      source += "(?:";
    } else if (char === "}" && depth > 0) {
      depth--;
      source += ")";
    } else if (char === "," && depth > 0) {
      source += "|";
    } else {
      source += escape(char);
    }
  }
  if (depth > 0) throw new Error(`unbalanced "{" in glob "${glob}"`);
  return new RegExp(`(?:^|/)${source}$`, ignoreCase ? "i" : "");
}

export function matchesGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}
