import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";

interface Finding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

const commentPatterns = {
  "//": /^(\s*)\/\/(.*)$/,
  "#": /^(\s*)#(.*)$/,
  "/*": /^(\s*)\/\*(.*)$/,
  "*/": /^(\s*)\*(.*)$/,
  "<!--": /^(\s*)<!--(.*)$/,
};

const temporalWords = [
  "now",
  "previously",
  "changed",
  "updated",
  "fixed",
  "instead of",
  "no longer",
  "used to",
  "as requested",
  "for now",
];

const reviewerPhrases = [
  "note to reviewer",
  "safe:",
  "as discussed",
  "per review",
  "per feedback",
];

function extractCommentText(line: string): string | null {
  for (const [, pattern] of Object.entries(commentPatterns)) {
    const match = line.match(pattern);
    if (match) {
      let text = match[2];
      if (text.endsWith("-->")) {
        text = text.slice(0, -3);
      }
      return text.trim();
    }
  }
  return null;
}

function checkTemporal(text: string): boolean {
  const lower = text.toLowerCase();
  return temporalWords.some((word) => lower.includes(word));
}

function checkReviewer(text: string): boolean {
  const lower = text.toLowerCase();
  return reviewerPhrases.some((phrase) => lower.includes(phrase));
}

function checkTodoNoIssue(text: string): boolean {
  if (!/\b(TODO|FIXME)\b/.test(text)) return false;
  return !/[#\w]?\d+|https?:\/\//.test(text);
}

function checkCommentedCode(text: string): boolean {
  if (text.endsWith(";") || text.endsWith("{")) return true;
  if (text.includes("=>")) return true;
  if (text.includes("function(")) return true;
  if (text.includes("$") && text.includes("=")) return true;
  return false;
}

function checkDash(text: string): boolean {
  return /[–—]/.test(text);
}

function splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function checkRestates(commentText: string, nextLine: string): boolean {
  const commentWords = new Set(splitIdentifier(commentText));
  const codeWords = new Set(splitIdentifier(nextLine));

  if (commentWords.size === 0 || codeWords.size === 0) return false;

  let overlap = 0;
  for (const word of commentWords) {
    if (codeWords.has(word)) overlap++;
  }

  const overlapRatio = overlap / commentWords.size;
  return overlapRatio >= 0.7;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("*") && !trimmed.startsWith("*/")) return true;
  if (trimmed.startsWith("@")) return true;
  return false;
}

interface FileLine {
  lineNum: number;
  content: string;
}

function getDiffLines(staged: boolean, rangeStr?: string): Map<string, FileLine[]> {
  let output: string;

  try {
    if (rangeStr) {
      const [from, to] = rangeStr.split("..");
      output = execSync(`git diff ${from}..${to}`, { encoding: "utf8" });
    } else if (staged) {
      output = execSync("git diff --cached", { encoding: "utf8" });
    } else {
      output = execSync("git diff HEAD", { encoding: "utf8" });
    }
  } catch {
    return new Map();
  }

  const files = new Map<string, FileLine[]>();
  let currentFile: string | null = null;
  let currentLineNum = 0;

  for (const line of output.split("\n")) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/b\/(.*?)$/);
      if (match) {
        currentFile = match[1];
        files.set(currentFile, []);
        currentLineNum = 0;
      }
    } else if (line.startsWith("@@")) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        currentLineNum = parseInt(match[1], 10) - 1;
      }
    } else if (currentFile && !line.startsWith("diff") && !line.startsWith("index") && !line.startsWith("---") && !line.startsWith("+++")) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        files.get(currentFile)!.push({
          lineNum: currentLineNum + 1,
          content: line.slice(1),
        });
        currentLineNum++;
      } else if (!line.startsWith("-") && line.startsWith(" ")) {
        currentLineNum++;
      }
    }
  }

  return files;
}

function isSupportedFile(file: string): boolean {
  const ext = file.split(".").pop()?.toLowerCase();
  return ["js", "ts", "css", "scss", "html", "php"].includes(ext || "");
}

function checkLine(
  line: string,
  nextLine: string,
): { rule: string; text: string } | null {
  const comment = extractCommentText(line);
  if (!comment) return null;

  if (isCommentLine(line)) return null;

  if (checkTemporal(comment)) {
    return { rule: "temporal", text: comment };
  }

  if (checkReviewer(comment)) {
    return { rule: "reviewer", text: comment };
  }

  if (checkTodoNoIssue(comment)) {
    return { rule: "todo-no-issue", text: comment };
  }

  if (checkCommentedCode(comment)) {
    return { rule: "commented-code", text: comment };
  }

  if (checkDash(comment)) {
    return { rule: "dash", text: comment };
  }

  if (nextLine && checkRestates(comment, nextLine)) {
    return { rule: "restates", text: comment };
  }

  return null;
}

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      staged: { type: "boolean" },
      range: { type: "string" },
      fail: { type: "boolean" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });

  const staged = values.staged === true || !values.range;
  const rangeStr = values.range as string | undefined;

  const files = getDiffLines(staged, rangeStr);
  const findings: Finding[] = [];

  for (const [file, addedLines] of files) {
    if (!isSupportedFile(file)) continue;

    for (let i = 0; i < addedLines.length; i++) {
      const line = addedLines[i];
      const nextLine = i + 1 < addedLines.length ? addedLines[i + 1].content : "";

      const issue = checkLine(line.content, nextLine);
      if (issue) {
        findings.push({
          file,
          line: line.lineNum,
          rule: issue.rule,
          text: issue.text.slice(0, 80),
        });
      }
    }
  }

  if (values.json) {
    console.log(JSON.stringify(findings));
  } else {
    for (const finding of findings) {
      console.log(`${finding.file}:${finding.line}  ${finding.rule}  ${finding.text}`);
    }
  }

  if (values.fail && findings.length > 0) {
    return 1;
  }

  return 0;
}

const command: Command = {
  name: "comment-lint",
  summary: "Flag comments that break the writing rules.",
  run,
};

export default command;
