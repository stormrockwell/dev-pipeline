import { homedir } from "node:os";

/**
 * Where paths get cut down to repo-relative form
 *
 * `repo` is the primary checkout. A worktree beside it in `<repo>-wt/<slug>`, or inside it under
 * `.pipeline/work/<slug>/worktrees/<id>`, counts as the same repo, so the same file read from two
 * worktrees is one step.
 */
export interface Roots {
  repo: string | null;
  home?: string;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A path as the same text across worktrees, works and temp folders
 */
export function relativePath(path: string, roots: Roots): string {
  let out = path;
  if (roots.repo !== null) out = out.replace(new RegExp(`^${escape(roots.repo)}(?:-wt/[^/]+)?/`), "");
  out = out.replace(/^(?:.*\/)?\.pipeline\/work\/[^/]+\/worktrees\/[^/]+[/]/, "");
  out = out.replace(/(^|\/)\.pipeline\/work\/[^/]+[/]/, "$1.pipeline/work/*/");
  out = out.replace(/^\/(?:private\/)?(?:tmp|var\/folders)\/.*\/([^/]+)$/, "<tmp>/$1");
  const home = roots.home ?? homedir();
  if (home !== "" && (out === home || out.startsWith(`${home}/`))) out = `~${out.slice(home.length)}`;
  return out;
}

// Programs whose first words name what they do, with how many of those words to keep.
const DEPTH: Record<string, number> = { gh: 2, pipeline: 2, npx: 2, wp: 2, claude: 2, git: 1, npm: 1, composer: 1, docker: 1, brew: 1, pnpm: 1, yarn: 1, vitest: 1, gitleaks: 1, semgrep: 1 };
// Second words worth keeping after the first.
const DEEPER: Record<string, string[]> = { git: ["worktree", "stash", "remote", "submodule"], npm: ["run"], composer: ["run"], docker: ["compose"], pnpm: ["run"], yarn: ["run"] };
// Words that open a command without being one.
const PREFIX = new Set(["env", "sudo", "time", "command", "exec", "nice", "do", "then", "else", "!"]);
// Statements that set up a shell or steer it, which say nothing about the work.
const SKIP = new Set(["cd", "export", "set", "source", ".", "for", "while", "until", "if", "elif", "fi", "done", "esac", "case", "true", "false", "sleep", "unset", "local", "[", "[[", "test", "{", "}"]);
// Shell commands that only look at files or text. Which file to look at next is judgment, so a run of these is not a sequence a script could replace.
export const LOOK = new Set(["cat", "sed", "head", "tail", "less", "more", "ls", "grep", "egrep", "rg", "find", "wc", "echo", "printf", "awk", "sort", "uniq", "cut", "tr", "jq", "file", "stat", "tree", "pwd", "which", "du", "nl", "xargs", "basename", "dirname", "realpath", "column", "diff", "comm", "date"]);
const WORD = /^[a-z][a-z0-9:_-]*$/;

/**
 * Splits a shell command into its statements, keeping only the first command of each pipe
 *
 * Quotes are honoured, and a here-document's body is dropped, so text fed to a command never reads as one.
 */
export function statements(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let piped = false;
  let heredoc: string | null = null;
  const flush = () => {
    if (!piped && current.trim() !== "") out.push(current.trim());
    current = "";
  };
  const lines = command.split("\n");
  for (const line of lines) {
    if (heredoc !== null) {
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    const opens = /<<-?\s*['"]?(\w+)['"]?/.exec(line);
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]!;
      const next = line[index + 1];
      if (quote !== null) {
        if (char === quote) quote = null;
        if (!piped) current += char;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        if (!piped) current += char;
        continue;
      }
      if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
        flush();
        piped = false;
        index += 1;
        continue;
      }
      if (char === ";") {
        flush();
        piped = false;
        continue;
      }
      if (char === "|") {
        flush();
        piped = true;
        continue;
      }
      if (!piped) current += char;
    }
    if (quote === null) {
      flush();
      piped = false;
    } else if (!piped) current += "\n";
    if (opens && quote === null) heredoc = opens[1]!;
  }
  flush();
  return out;
}

/**
 * A statement's words, with quotes and closing brackets taken off
 */
function words(statement: string): string[] {
  return (statement.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((word) => word.replace(/\)+$/, "").replace(/^(['"])([\s\S]*)\1$/, "$2"));
}

/**
 * What one shell statement does, as its program and the words that name the action
 *
 * `git -C dir push -u origin x` and `git push` are both `git push`: the arguments vary from run to
 * run, and the program with its subcommand is what repeats.
 */
export function commandStep(statement: string): string | null {
  const all = words(statement.replace(/^[(\s]+/, "")).filter((word, index, list) => !/^\d?[<>&]/.test(word) && !/^\d?[<>]{1,2}$/.test(list[index - 1] ?? ""));
  let index = 0;
  while (index < all.length && (PREFIX.has(all[index]!) || /^\w+=/.test(all[index]!))) index += 1;
  const first = all[index];
  if (first === undefined) return null;
  const program = first.split("/").pop()!;
  if (SKIP.has(program) || program === "" || program.startsWith("-")) return null;
  const rest = all.slice(index + 1);
  if (program === "git") {
    while (rest[0] !== undefined && /^-[Cc]$/.test(rest[0])) rest.splice(0, 2);
    while (rest[0]?.startsWith("-")) rest.shift();
  }
  if (program === "node" || /^python3?$/.test(program)) {
    const flag = rest.find((word) => ["--test", "-e", "-c", "--check", "-m"].includes(word));
    if (flag) return `${program} ${flag}`;
    const script = rest.find((word) => !word.startsWith("-"));
    return script ? `${program} ${script.split("/").pop()}` : program;
  }
  const depth = DEPTH[program] ?? 0;
  const kept: string[] = [program];
  for (const word of rest) {
    if (kept.length > depth + ((DEEPER[program] ?? []).includes(kept[1] ?? "") ? 1 : 0)) break;
    if (!WORD.test(word)) break;
    kept.push(word);
  }
  return kept.join(" ");
}

/**
 * The steps one tool call stands for
 *
 * A shell call is one step per statement, so `git add && git commit` mines the same as two calls.
 * A file tool keeps its repo-relative path, a search its pattern, a skill or agent its name. Other
 * tools are their name alone.
 */
export function steps(tool: string, input: string, roots: Roots): string[] {
  switch (tool) {
    case "Bash":
      return statements(input).map(commandStep).filter((step): step is string => step !== null);
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return [`${tool} ${relativePath(input, roots)}`];
    case "Grep":
    case "Glob":
      return [`${tool} ${input.split(" in ")[0]!.slice(0, 80)}`];
    case "Skill":
      return [`Skill ${input}`];
    case "Agent":
    case "Task":
      return [`Agent ${input.split(" ")[0] ?? ""}`.trim()];
    default:
      return [tool];
  }
}
