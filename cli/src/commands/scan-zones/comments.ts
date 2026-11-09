import { extname } from "node:path";
import type { FileInput } from "./types.ts";

type Language = "sql" | "php" | "js";

const languages: Record<string, Language> = {
  ".sql": "sql",
  ".php": "php",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".ts": "js",
  ".mts": "js",
  ".cts": "js",
};

interface Block {
  // Zero-based first and last line of a block comment.
  start: number;
  end: number;
}

interface Analysis {
  // True for a line that holds only whitespace and comment text, so no code runs from it.
  inert: boolean[];
  blocks: Block[];
}

// `--` starts a MySQL comment only when whitespace follows, so `--1` stays code.
function startsLineComment(language: Language, text: string, at: number): boolean {
  const rest = text.slice(at);
  if (language === "sql") return /^--(\s|$)/.test(rest) || rest.startsWith("#");
  if (language === "php") return rest.startsWith("//") || (rest.startsWith("#") && !rest.startsWith("#["));
  return rest.startsWith("//");
}

/**
 * Walks the new file once and marks the lines that hold no code. A MySQL conditional comment
 * (`/*!`) or optimizer hint (`/*+`) runs, so it counts as code. The walk follows strings across lines,
 * because a `--` inside a multi line string literal is data and not a comment.
 */
function analyze(lines: string[], language: Language): Analysis {
  const inert: boolean[] = [];
  const blocks: Block[] = [];
  let open: { start: number; runs: boolean } | null = null;
  let quote: string | null = null;

  for (let index = 0; index < lines.length; index++) {
    const text = lines[index]!;
    let code = quote !== null || open?.runs === true;
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      if (open) {
        if (char === "*" && text[i + 1] === "/") {
          blocks.push({ start: open.start, end: index });
          open = null;
          i++;
        }
      } else if (quote) {
        code = true;
        if (char === "\\") i++;
        else if (char === quote) quote = null;
      } else if (char === "/" && text[i + 1] === "*") {
        const runs = language === "sql" && (text[i + 2] === "!" || text[i + 2] === "+");
        open = { start: index, runs };
        if (runs) code = true;
        i++;
      } else if (startsLineComment(language, text, i)) {
        break;
      } else if (char === "'" || char === '"' || char === "`") {
        quote = char;
        code = true;
      } else if (!/\s/.test(char)) {
        code = true;
      }
    }
    inert.push(!code);
  }
  return { inert, blocks };
}

/**
 * Whether a removed line is a comment on its own. The old file is not available, so a line that opens
 * or closes a block comment is never trusted, because removing it could uncomment code beside it.
 */
function removedLineIsComment(language: Language, text: string): boolean {
  const line = text.trim();
  if (line === "") return true;
  if (startsLineComment(language, line, 0)) return true;
  if (/^\*(\s|$)/.test(line) && !line.includes("*/")) return true;
  const whole = /^\/\*([\s\S]*?)\*\/$/.exec(line);
  if (!whole || whole[1]!.includes("*/")) return false;
  return !(language === "sql" && /^[!+]/.test(whole[1]!));
}

/**
 * Whether a diff only adds, removes or rewords comments and blank lines, so a path rule that exists to
 * catch schema changes has nothing to catch. A new file stays a hit because the migration itself is the
 * change, and an unknown file type stays a hit because its comment syntax is not known.
 */
export function isCommentOnlyChange(input: FileInput): boolean {
  if (input.added === null || input.deleted || input.content === null) return false;
  const language = languages[extname(input.path).toLowerCase()];
  if (!language) return false;
  if (input.added.size === 0 && input.removed.length === 0) return false;

  const lines = input.content.split(/\r?\n/);
  const everyLineNew = lines.every((text, index) => text.trim() === "" || input.added!.has(index + 1));
  if (everyLineNew && input.removed.length === 0) return false;

  const { inert, blocks } = analyze(lines, language);
  for (const number of input.added) {
    const index = number - 1;
    if (index >= lines.length || !inert[index]) return false;
  }
  for (const entry of input.removed) if (!removedLineIsComment(language, entry.text)) return false;

  // A block comment that gained or lost a delimiter can swallow code that sits inside it.
  for (const block of blocks) {
    const touched = [...input.added].some((number) => number - 1 >= block.start && number - 1 <= block.end);
    if (!touched) continue;
    const edgesMoved = input.added.has(block.start + 1) || input.added.has(block.end + 1);
    if (!edgesMoved) continue;
    for (let line = block.start + 1; line <= block.end + 1; line++) {
      if (!input.added.has(line) && lines[line - 1]!.trim() !== "") return false;
    }
  }
  return true;
}
