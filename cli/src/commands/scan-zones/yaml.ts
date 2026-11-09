/**
 * A reader for the YAML subset that sensitive.yml needs, so the CLI keeps zero runtime dependencies.
 * It handles block mappings, block sequences of scalars or mappings, flow sequences of scalars,
 * quoted and plain scalars, and comments. Anchors, tags, block scalars, flow mappings and multiple
 * documents are rejected with a line number instead of being misread.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
  no: number;
}

class YamlError extends Error {
  constructor(no: number, message: string) {
    super(`line ${no}: ${message}`);
  }
}

// Cuts a trailing comment, leaving a hash inside quotes or inside a word alone.
function stripComment(text: string, no: number): string {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    const before = i === 0 ? " " : text[i - 1]!;
    if (quote === "'") {
      if (char === "'") {
        if (text[i + 1] === "'") i++;
        else quote = null;
      }
    } else if (quote === '"') {
      if (char === "\\") i++;
      else if (char === '"') quote = null;
    } else if ((char === "'" || char === '"') && /[\s[,]/.test(before)) {
      quote = char;
    } else if (char === "#" && /\s/.test(before)) {
      return text.slice(0, i);
    }
  }
  if (quote) throw new YamlError(no, "unterminated quoted string");
  return text;
}

function tokenize(source: string): Line[] {
  const lines: Line[] = [];
  const raw = source.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < raw.length; i++) {
    const no = i + 1;
    const stripped = stripComment(raw[i]!, no).trimEnd();
    if (stripped.trim() === "") continue;
    if (/^\t/.test(stripped) || /^ *\t/.test(stripped)) throw new YamlError(no, "tab indentation is not allowed");
    const indent = stripped.length - stripped.trimStart().length;
    const text = stripped.trimStart();
    if (indent === 0 && text === "---" && lines.length === 0) continue;
    if (indent === 0 && (text === "---" || text === "...")) throw new YamlError(no, "multiple documents are not supported");
    lines.push({ indent, text, no });
  }
  return lines;
}

const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", "\\": "\\", '"': '"', "/": "/", " ": " " };

function unquote(text: string, no: number): string {
  const quote = text[0];
  const body = text.slice(1, -1);
  if (quote === "'") return body.replace(/''/g, "'");
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, code: string) => {
    if (code.length > 1) return String.fromCharCode(parseInt(code.slice(1), 16));
    const value = escapes[code];
    if (value === undefined) throw new YamlError(no, `unknown escape "\\${code}"`);
    return value;
  });
}

// Index of the closing quote of a quoted scalar that starts at 0, or -1.
function closingQuote(text: string): number {
  const quote = text[0];
  for (let i = 1; i < text.length; i++) {
    if (quote === "'" && text[i] === "'") {
      if (text[i + 1] === "'") i++;
      else return i;
    } else if (quote === '"') {
      if (text[i] === "\\") i++;
      else if (text[i] === '"') return i;
    }
  }
  return -1;
}

function parseScalar(text: string, no: number): YamlValue {
  if (text[0] === "'" || text[0] === '"') {
    const end = closingQuote(text);
    if (end !== text.length - 1) throw new YamlError(no, end < 0 ? "unterminated quoted string" : "text after a quoted string");
    return unquote(text, no);
  }
  if (text[0] === "[") return parseFlowList(text, no);
  if (text[0] === "{") throw new YamlError(no, "flow mappings are not supported");
  if (text[0] === "|" || text[0] === ">") throw new YamlError(no, "block scalars are not supported");
  if (text[0] === "&" || text[0] === "*" || text[0] === "!") throw new YamlError(no, "anchors, aliases and tags are not supported");
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

function parseFlowList(text: string, no: number): YamlValue[] {
  if (text[text.length - 1] !== "]") throw new YamlError(no, "unterminated flow list");
  const inner = text.slice(1, -1).trim();
  const items: YamlValue[] = [];
  let rest = inner;
  while (rest !== "") {
    let item: string;
    if (rest[0] === "'" || rest[0] === '"') {
      const end = closingQuote(rest);
      if (end < 0) throw new YamlError(no, "unterminated quoted string");
      item = rest.slice(0, end + 1);
      rest = rest.slice(end + 1).trimStart();
    } else {
      const comma = rest.indexOf(",");
      item = (comma < 0 ? rest : rest.slice(0, comma)).trim();
      rest = comma < 0 ? "" : rest.slice(comma);
    }
    if (item.startsWith("[") || item.startsWith("{")) throw new YamlError(no, "nested flow collections are not supported");
    items.push(parseScalar(item, no));
    if (rest.startsWith(",")) rest = rest.slice(1).trimStart();
    else if (rest !== "") throw new YamlError(no, "expected a comma in the flow list");
  }
  return items;
}

// Splits `key: value` into its parts, or returns null when the text is a plain scalar.
function splitEntry(text: string): { key: string; rest: string } | null {
  if (text[0] === "'" || text[0] === '"') {
    const end = closingQuote(text);
    if (end < 0 || !/^:(\s|$)/.test(text.slice(end + 1))) return null;
    return { key: text.slice(0, end + 1), rest: text.slice(end + 2).trim() };
  }
  if (text[0] === "[" || text[0] === "{") return null;
  const match = /^([^\s:][^:]*?|[^\s:]):(?:\s+(.*))?$/.exec(text);
  return match ? { key: match[1]!, rest: (match[2] ?? "").trim() } : null;
}

class Reader {
  private pos = 0;
  private readonly lines: Line[];

  constructor(lines: Line[]) {
    this.lines = lines;
  }

  peek(): Line | undefined {
    return this.lines[this.pos];
  }

  // Replaces the dash line with the item's own content so a mapping can continue on the next lines.
  private inlineItem(line: Line): void {
    const after = line.text.slice(1);
    const spaces = after.length - after.trimStart().length;
    this.lines[this.pos] = { indent: line.indent + 1 + spaces, text: after.trimStart(), no: line.no };
  }

  parseBlock(indent: number): YamlValue {
    const line = this.peek()!;
    return /^-(\s|$)/.test(line.text) ? this.parseSequence(indent) : this.parseMapping(indent);
  }

  private parseSequence(indent: number): YamlValue[] {
    const items: YamlValue[] = [];
    for (let line = this.peek(); line && line.indent === indent && /^-(\s|$)/.test(line.text); line = this.peek()) {
      if (line.text === "-") {
        this.pos++;
        const next = this.peek();
        items.push(next && next.indent > indent ? this.parseBlock(next.indent) : null);
        continue;
      }
      this.inlineItem(line);
      const item = this.peek()!;
      items.push(splitEntry(item.text) ? this.parseMapping(item.indent) : (this.pos++, parseScalar(item.text, item.no)));
    }
    return items;
  }

  private parseMapping(indent: number): { [key: string]: YamlValue } {
    const map: { [key: string]: YamlValue } = {};
    for (let line = this.peek(); line && line.indent === indent; line = this.peek()) {
      const entry = splitEntry(line.text);
      if (!entry) throw new YamlError(line.no, "expected a `key: value` entry");
      const key = entry.key[0] === "'" || entry.key[0] === '"' ? unquote(entry.key, line.no) : entry.key;
      if (Object.hasOwn(map, key)) throw new YamlError(line.no, `duplicate key "${key}"`);
      this.pos++;
      if (entry.rest !== "") {
        map[key] = parseScalar(entry.rest, line.no);
        continue;
      }
      const next = this.peek();
      if (next && next.indent > indent) map[key] = this.parseBlock(next.indent);
      else if (next && next.indent === indent && /^-(\s|$)/.test(next.text)) map[key] = this.parseSequence(indent);
      else map[key] = null;
    }
    return map;
  }
}

export function parseYaml(source: string): YamlValue {
  const lines = tokenize(source);
  if (lines.length === 0) return {};
  const reader = new Reader(lines);
  const first = lines[0]!;
  if (first.indent !== 0) throw new YamlError(first.no, "unexpected indentation");
  const value = reader.parseBlock(0);
  const extra = reader.peek();
  if (extra) throw new YamlError(extra.no, "unexpected indentation");
  return value;
}
