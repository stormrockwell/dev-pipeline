/**
 * A small POSIX-style shell tokenizer. It does not execute or expand anything. It only
 * splits a command line into simple commands with their quotes and escapes resolved, and
 * it digs commands out of subshells, `$( )` and backticks so a caller can inspect each one.
 */

export interface SimpleCommand {
  words: string[];
  /** Heredoc and here-string bodies attached to this command, in order. */
  heredocs: string[];
  /** The command whose output feeds this one through a pipe. */
  pipedFrom?: SimpleCommand;
}

interface PendingHeredoc {
  delimiter: string;
  strip: boolean;
  quoted: boolean;
  target: SimpleCommand;
}

const MAX_BRACE_RESULTS = 64;

/** Placeholder text for a substitution, since the guard cannot know what it expands to. */
const SUBSTITUTION = "$(…)";
const BACKTICK = "`…`";

/**
 * Expands the first top-level `{a,b}` group, recursively. Words with no comma group come
 * back unchanged.
 */
export function expandBraces(word: string): string[] {
  for (let start = 0; start < word.length; start++) {
    if (word[start] !== "{") continue;
    let depth = 0;
    const commas: number[] = [];
    for (let i = start; i < word.length; i++) {
      if (word[i] === "{") depth++;
      else if (word[i] === "}") {
        depth--;
        if (depth === 0) {
          if (commas.length === 0) break;
          const prefix = word.slice(0, start);
          const suffix = word.slice(i + 1);
          const bounds = [start, ...commas, i];
          const results: string[] = [];
          for (let k = 0; k < bounds.length - 1; k++) {
            const alternative = word.slice(bounds[k]! + 1, bounds[k + 1]);
            for (const expanded of expandBraces(prefix + alternative + suffix)) {
              results.push(expanded);
              if (results.length >= MAX_BRACE_RESULTS) return results;
            }
          }
          return results;
        }
      } else if (word[i] === "," && depth === 1) commas.push(i);
    }
  }
  return [word];
}

const ANSI_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  f: "\f",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
};

class Parser {
  readonly out: SimpleCommand[] = [];
  private i = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  /**
   * Parses commands until the end of input or, when nested, the `)` that closes the
   * enclosing `$(` or `(`.
   */
  parseList(nested: boolean): void {
    const src = this.src;
    let words: string[] = [];
    let buf: string | null = null;
    let plain = true;
    let current: SimpleCommand = { words: [], heredocs: [] };
    let pipeFrom: SimpleCommand | undefined;
    let lastEnded: SimpleCommand | undefined;
    let redirectNext = false;
    let heredocNext: { strip: boolean } | undefined;
    let hereStringNext = false;
    const pending: PendingHeredoc[] = [];

    const endWord = () => {
      if (buf === null) return;
      const word = buf;
      const wasPlain = plain;
      buf = null;
      plain = true;
      if (heredocNext) {
        pending.push({
          delimiter: word,
          strip: heredocNext.strip,
          quoted: !wasPlain,
          target: current,
        });
        heredocNext = undefined;
      } else if (hereStringNext) {
        current.heredocs.push(word);
        hereStringNext = false;
      } else if (redirectNext) {
        redirectNext = false;
      } else if (wasPlain && word.includes("{")) {
        words.push(...expandBraces(word));
      } else {
        words.push(word);
      }
    };

    const endCommand = () => {
      endWord();
      if (words.length > 0) {
        current.words = words;
        current.pipedFrom = pipeFrom;
        this.out.push(current);
        lastEnded = current;
        words = [];
        current = { words: [], heredocs: [] };
      }
    };

    const readHeredocs = () => {
      for (const heredoc of pending.splice(0)) {
        const lines: string[] = [];
        while (this.i < src.length) {
          let end = src.indexOf("\n", this.i);
          if (end === -1) end = src.length;
          const line = src.slice(this.i, end);
          this.i = Math.min(end + 1, src.length);
          const compare = heredoc.strip ? line.replace(/^\t+/, "") : line;
          if (compare === heredoc.delimiter) break;
          lines.push(line);
        }
        const body = lines.join("\n");
        heredoc.target.heredocs.push(body);
        if (!heredoc.quoted) this.scanSubstitutions(body);
      }
    };

    const append = (text: string, isPlain: boolean) => {
      buf = (buf ?? "") + text;
      if (!isPlain) plain = false;
    };

    while (this.i < src.length) {
      const c = src[this.i]!;
      const next = src[this.i + 1];

      if (c === " " || c === "\t") {
        endWord();
        this.i++;
      } else if (c === "\n") {
        const hadContent = words.length > 0 || buf !== null;
        endCommand();
        if (hadContent) pipeFrom = undefined;
        this.i++;
        readHeredocs();
      } else if (c === "#" && buf === null) {
        while (this.i < src.length && src[this.i] !== "\n") this.i++;
      } else if (c === "\\") {
        if (next === "\n") this.i += 2;
        else if (next === undefined) this.i++;
        else {
          append(next, false);
          this.i += 2;
        }
      } else if (c === "'") {
        const end = src.indexOf("'", this.i + 1);
        const stop = end === -1 ? src.length : end;
        append(src.slice(this.i + 1, stop), false);
        this.i = stop + 1;
      } else if (c === '"') {
        buf ??= "";
        plain = false;
        this.i++;
        this.readDoubleQuoted((text) => append(text, false));
      } else if (c === "`") {
        this.i++;
        append(this.readBacktick(), false);
      } else if (c === "$" && next === "(") {
        this.i += 2;
        this.parseList(true);
        append(SUBSTITUTION, false);
      } else if (c === "$" && next === "'") {
        this.i += 2;
        append(this.readAnsiC(), false);
      } else if (c === "$" && next === '"') {
        this.i++;
      } else if (c === "$" && next === "{") {
        const end = src.indexOf("}", this.i);
        const stop = end === -1 ? src.length : end + 1;
        append(src.slice(this.i, stop), false);
        this.i = stop;
      } else if ((c === "<" || c === ">") && next === "(") {
        this.i += 2;
        this.parseList(true);
        append(SUBSTITUTION, false);
      } else if (c === "<" || c === ">" || (c === "&" && next === ">")) {
        if (buf !== null && plain && /^\d+$/.test(buf)) buf = null;
        else endWord();
        let j = this.i;
        if (src[j] === "&") j++;
        while (src[j] === "<" || src[j] === ">") j++;
        const operator = src.slice(this.i, j);
        if (src[j] === "&" || src[j] === "|") j++;
        else if (operator === "<<" && src[j] === "-") {
          j++;
          heredocNext = { strip: true };
        }
        if (operator === "<<" && !heredocNext) heredocNext = { strip: false };
        else if (operator === "<<<") hereStringNext = true;
        else if (!heredocNext) redirectNext = true;
        this.i = j;
      } else if (c === ";" || c === "&" || c === "|") {
        endCommand();
        let j = this.i;
        while (src[j] === ";" || src[j] === "&" || src[j] === "|") j++;
        const operator = src.slice(this.i, j);
        pipeFrom = operator === "|" || operator === "|&" ? lastEnded : undefined;
        this.i = j;
      } else if (c === "(") {
        endCommand();
        this.i++;
        this.parseList(true);
      } else if (c === ")") {
        endCommand();
        this.i++;
        if (nested) return;
      } else {
        append(c, true);
        this.i++;
      }
    }
    endCommand();
  }

  /** Finds `$( )` and backtick commands inside text that the shell would expand. */
  scanSubstitutions(text: string): void {
    const parser = new Parser(text);
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\\") i++;
      else if (text[i] === "$" && text[i + 1] === "(") {
        parser.i = i + 2;
        parser.parseList(true);
        i = parser.i - 1;
      } else if (text[i] === "`") {
        parser.i = i + 1;
        parser.readBacktick();
        i = parser.i - 1;
      }
    }
    this.out.push(...parser.out);
  }

  private readDoubleQuoted(append: (text: string) => void): void {
    const src = this.src;
    while (this.i < src.length) {
      const c = src[this.i]!;
      const next = src[this.i + 1];
      if (c === '"') {
        this.i++;
        return;
      }
      if (c === "\\" && next !== undefined) {
        if (next === "\n") {
          // A line continuation inside quotes is removed.
        } else if (next === "$" || next === "`" || next === '"' || next === "\\") append(next);
        else append(c + next);
        this.i += 2;
      } else if (c === "$" && next === "(") {
        this.i += 2;
        this.parseList(true);
        append(SUBSTITUTION);
      } else if (c === "`") {
        this.i++;
        append(this.readBacktick());
      } else {
        append(c);
        this.i++;
      }
    }
  }

  /** Reads up to the closing backtick and parses what is inside as a nested script. */
  private readBacktick(): string {
    const src = this.src;
    let text = "";
    while (this.i < src.length && src[this.i] !== "`") {
      if (src[this.i] === "\\" && /[`\\$]/.test(src[this.i + 1] ?? "")) this.i++;
      text += src[this.i];
      this.i++;
    }
    this.i++;
    const inner = new Parser(text);
    inner.parseList(false);
    this.out.push(...inner.out);
    return BACKTICK;
  }

  private readAnsiC(): string {
    const src = this.src;
    let text = "";
    while (this.i < src.length && src[this.i] !== "'") {
      if (src[this.i] === "\\" && this.i + 1 < src.length) {
        const escape = src[this.i + 1]!;
        const hex = /^x([0-9a-fA-F]{1,2})/.exec(src.slice(this.i + 1, this.i + 4));
        const octal = /^([0-7]{1,3})/.exec(src.slice(this.i + 1, this.i + 4));
        if (hex) {
          text += String.fromCharCode(parseInt(hex[1]!, 16));
          this.i += 1 + hex[0].length;
        } else if (octal) {
          text += String.fromCharCode(parseInt(octal[1]!, 8));
          this.i += 1 + octal[0].length;
        } else {
          text += ANSI_ESCAPES[escape] ?? escape;
          this.i += 2;
        }
      } else {
        text += src[this.i];
        this.i++;
      }
    }
    this.i++;
    return text;
  }
}

/**
 * Returns every simple command in the source, including those inside substitutions and
 * subshells. A command nested inside another appears before the command that contains it.
 */
export function parseShell(source: string): SimpleCommand[] {
  const parser = new Parser(source);
  parser.parseList(false);
  return parser.out;
}
