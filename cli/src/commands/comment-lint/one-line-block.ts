// Carried from one added line to the next, because quotes and block comments can span lines.
export interface ScanState {
  block: boolean;
  template: boolean;
}

export interface OneLineBlock {
  start: number;
  end: number;
  text: string;
}

const extensions = new Set(["js", "ts", "mjs", "cjs", "php"]);

// Tool directives are read by their tool from the block form, so they cannot become line comments.
const directive =
  /^(?:eslint[\w-]*|globals?|exported|istanbul|c8|v8|prettier[\w-]*|phpcs[\w-]*|phpstan[\w-]*|jshint|jscs|tslint|vitest-environment|#__\w+__)(?=[\s:]|$)/;

// A slash after one of these starts a regular expression, and after anything else it divides.
const regexOpeners = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

export function newScanState(): ScanState {
  return { block: false, template: false };
}

export function supportsOneLineBlock(file: string): boolean {
  return extensions.has(file.split(".").pop()?.toLowerCase() ?? "");
}

function commentText(raw: string): string {
  return raw.replace(/^\*+/, "").replace(/\*+$/, "").trim();
}

function isException(raw: string, text: string): boolean {
  return raw.startsWith("!") || raw.includes("@") || directive.test(text);
}

function skipQuoted(line: string, from: number): number {
  const quote = line[from];
  for (let i = from + 1; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === quote) return i + 1;
  }
  return line.length;
}

// Returns the index after a regular expression literal, or -1 when the slash is not one.
function skipRegex(line: string, from: number): number {
  let inClass = false;
  for (let i = from + 1; i < line.length; i++) {
    const char = line[i];
    if (char === "\\") i++;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      let end = i + 1;
      while (/[a-z]/i.test(line[end] ?? "")) end++;
      return end;
    }
  }
  return -1;
}

/**
 * Finds a block comment that opens and closes on this line with nothing after it.
 * The scan walks the whole line so that comment markers inside strings, template literals,
 * regular expressions and other comments are never mistaken for a comment.
 */
export function scanLine(line: string, php: boolean, state: ScanState): OneLineBlock | null {
  let found: OneLineBlock | null = null;
  let last = "";
  let i = 0;

  while (i < line.length) {
    if (state.block) {
      const close = line.indexOf("*/", i);
      if (close === -1) return null;
      state.block = false;
      i = close + 2;
      continue;
    }

    const char = line[i];
    const next = line[i + 1];

    if (state.template) {
      if (char === "\\") i++;
      else if (char === "`") state.template = false;
      i++;
      continue;
    }

    if (char === "'" || char === '"') {
      i = skipQuoted(line, i);
      last = char;
      continue;
    }

    if (char === "`" && !php) {
      state.template = true;
      i++;
      continue;
    }

    if (char === "/" && next === "/") return found;
    if (php && char === "#" && next !== "[") return found;

    if (char === "/" && next === "*") {
      const close = line.indexOf("*/", i + 2);
      if (close === -1) {
        state.block = true;
        return found;
      }
      const raw = line.slice(i + 2, close);
      const text = commentText(raw);
      if (line.slice(close + 2).trim() === "" && text && !isException(raw, text)) {
        found = { start: i, end: close + 2, text };
      }
      i = close + 2;
      continue;
    }

    if (char === "/" && !php && (regexOpeners.has(last) || /\b(?:return|typeof)$/.test(line.slice(0, i).trimEnd()))) {
      const end = skipRegex(line, i);
      if (end !== -1) {
        i = end;
        last = "/";
        continue;
      }
    }

    if (!/\s/.test(char)) last = char;
    i++;
  }

  return found;
}

export function toLineComment(line: string, block: OneLineBlock): string {
  const carriageReturn = line.endsWith("\r") ? "\r" : "";
  return `${line.slice(0, block.start)}// ${block.text}${carriageReturn}`;
}
