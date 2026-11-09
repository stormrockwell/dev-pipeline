import { basename, resolve } from "node:path";
import { checkGh } from "./gh.ts";
import { checkGit, RepoState } from "./git.ts";
import { checkSecretReads } from "./reads.ts";
import { parseShell, type SimpleCommand } from "./shell.ts";
import { strictest, verdict, type Verdict } from "./verdict.ts";
import { checkWp } from "./wp.ts";

const MAX_DEPTH = 8;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
const KEYWORDS = new Set(["{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const EXPORTERS = new Set(["export", "declare", "typeset", "readonly", "local"]);

interface Wrapper {
  // Flags that take the next word as a value.
  valueFlags: string[];
  // Plain words to skip before the wrapped command, such as the duration for `timeout`.
  positionals?: number;
}

const WRAPPERS: Record<string, Wrapper> = {
  command: { valueFlags: [] },
  builtin: { valueFlags: [] },
  exec: { valueFlags: ["-a"] },
  sudo: { valueFlags: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t"] },
  doas: { valueFlags: ["-u", "-C"] },
  xargs: { valueFlags: ["-I", "-n", "-L", "-P", "-d", "-E", "-s", "-a", "-J"] },
  nice: { valueFlags: ["-n"] },
  time: { valueFlags: ["-f", "-o"] },
  nohup: { valueFlags: [] },
  setsid: { valueFlags: [] },
  timeout: { valueFlags: ["-s", "-k"], positionals: 1 },
  stdbuf: { valueFlags: ["-i", "-o", "-e"] },
  ionice: { valueFlags: ["-c", "-n", "-p"] },
  caffeinate: { valueFlags: ["-t", "-w"] },
  watch: { valueFlags: ["-n", "-d"] },
};

export interface TraceEntry {
  // The words of the simple command as the tokenizer produced them.
  words: string[];
  // The command left after wrappers and assignments are removed.
  command: string[];
  assignments: string[];
  verdicts: Verdict[];
}

export interface BashResult extends Verdict {
  trace: TraceEntry[];
}

interface Walk {
  repo: RepoState;
  dir: string;
  trace: TraceEntry[];
  verdicts: Verdict[];
  // Variables set by a bare `name=value` command earlier in the line.
  vars: Map<string, string>;
}

// Substitutes `$name` and `${name}` for variables the command line set itself.
function expandVars(word: string, vars: Map<string, string>): string {
  if (vars.size === 0 || !word.includes("$")) return word;
  return word.replace(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (match, braced?: string, bare?: string) => {
    return vars.get(braced ?? bare ?? "") ?? match;
  });
}

function isAssignment(word: string): boolean {
  return ASSIGNMENT.test(word);
}

// Removes keywords, assignments and wrappers from the front, returning the real command.
function unwrap(words: string[], assignments: string[]): string[] {
  let argv = words;
  for (let guard = 0; guard < 32 && argv.length > 0; guard++) {
    const head = argv[0]!;
    if (KEYWORDS.has(head)) {
      argv = argv.slice(1);
    } else if (isAssignment(head)) {
      assignments.push(head);
      argv = argv.slice(1);
    } else if (basename(head) === "env") {
      argv = unwrapEnv(argv.slice(1), assignments);
    } else if (WRAPPERS[basename(head)]) {
      const rest = unwrapWrapper(basename(head), argv.slice(1));
      if (rest === undefined) return [];
      argv = rest;
    } else {
      break;
    }
  }
  return argv;
}

function unwrapWrapper(name: string, args: string[]): string[] | undefined {
  const spec = WRAPPERS[name]!;
  let skipPositionals = spec.positionals ?? 0;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      i++;
      break;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      // `command -v git` only looks the command up, so nothing runs.
      if (name === "command" && /^-[a-zA-Z]*[vV]/.test(arg)) return undefined;
      if (spec.valueFlags.includes(arg)) i++;
    } else if (skipPositionals > 0) {
      skipPositionals--;
    } else {
      break;
    }
  }
  return args.slice(i);
}

function unwrapEnv(args: string[], assignments: string[]): string[] {
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      i++;
      break;
    }
    if (isAssignment(arg)) assignments.push(arg);
    else if (arg === "-S" || arg === "--split-string") {
      return [...(parseShell(args[i + 1] ?? "")[0]?.words ?? []), ...args.slice(i + 2)];
    } else if (arg === "-u" || arg === "-C" || arg === "--unset" || arg === "--chdir") i++;
    else if (!arg.startsWith("-") || arg === "-") break;
  }
  return args.slice(i);
}

// Finds the script a shell would run: the `-c` string, or the text piped or redirected into it.
function shellScripts(command: SimpleCommand, argv: string[]): string[] {
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) return args[i + 1] === undefined ? [] : [args[i + 1]!];
    if (arg === "-o" || arg === "+o") i++;
    else if (!arg.startsWith("-") && !arg.startsWith("+")) return [];
  }
  const scripts = [...command.heredocs];
  const source = command.pipedFrom;
  if (source) {
    const sourceWords = unwrap(source.words, []);
    const name = basename(sourceWords[0] ?? "");
    if (name === "echo") scripts.push(sourceWords.slice(1).filter((w) => !w.startsWith("-")).join(" "));
    else if (name === "printf") {
      const [format = "", ...rest] = sourceWords.slice(1);
      scripts.push(format.includes("%") ? rest.join("\n") : [format, ...rest].join(" "));
    } else if (name === "cat") scripts.push(...source.heredocs);
  }
  return scripts;
}

// Collects the commands that `find -exec` runs.
function findExecs(argv: string[]): string[][] {
  const commands: string[][] = [];
  for (let i = 1; i < argv.length; i++) {
    if (["-exec", "-execdir", "-ok", "-okdir"].includes(argv[i]!)) {
      let end = i + 1;
      while (end < argv.length && argv[end] !== ";" && argv[end] !== "+") end++;
      commands.push(argv.slice(i + 1, end));
      i = end;
    }
  }
  return commands;
}

function inspect(command: SimpleCommand, walk: Walk, depth: number): void {
  const assignments: string[] = [];
  const words = command.words.map((word) => expandVars(word, walk.vars));
  const argv = unwrap(words, assignments);
  const program = basename(argv[0] ?? "");
  const found: Verdict[] = [];

  if (EXPORTERS.has(program)) assignments.push(...argv.slice(1).filter(isAssignment));
  if (assignments.includes("HUSKY=0")) {
    found.push(verdict("deny", "husky-skip", "HUSKY=0 skips the git hooks, which are the gates"));
  }

  const args = argv.slice(1);
  if (program === "git") found.push(...checkGit(args, walk.repo, walk.dir));
  else if (program === "gh") found.push(...checkGh(args));
  else if (program === "wp") found.push(...checkWp(args));
  found.push(
    ...checkSecretReads(argv, command, {
      dir: walk.dir,
      viaXargs: words.slice(0, words.length - argv.length).some((word) => basename(word) === "xargs"),
      unwrap: (list) => unwrap(list, []),
    }),
  );
  if (program === "cd" || program === "pushd") {
    if (args[0] && !args[0].startsWith("-")) walk.dir = resolve(walk.dir, args[0]);
  }

  if (argv.length === 0) {
    for (const entry of assignments) {
      const equals = entry.indexOf("=");
      walk.vars.set(entry.slice(0, equals).replace(/\+$/, ""), entry.slice(equals + 1));
    }
  }

  walk.trace.push({ words: command.words, command: argv, assignments, verdicts: found });
  walk.verdicts.push(...found);

  const nested: string[] = [];
  if (SHELLS.has(program)) nested.push(...shellScripts(command, argv));
  if (program === "eval") nested.push(args.join(" "));
  const nestedCommands = program === "find" ? findExecs(argv) : [];

  if (nested.length > 0 || nestedCommands.length > 0) {
    if (depth >= MAX_DEPTH) {
      walk.verdicts.push(
        verdict("ask", "shell-nesting", "Shell strings nest too deeply to verify, so confirm the command"),
      );
      return;
    }
    for (const script of nested) walkSource(script, walk, depth + 1);
    for (const words of nestedCommands) inspect({ words, heredocs: [], inputs: [] }, walk, depth + 1);
  }
}

function walkSource(source: string, walk: Walk, depth: number): void {
  for (const command of parseShell(source)) inspect(command, walk, depth);
}

// Decides a Bash command. The strictest verdict across every simple command in it wins.
export function decideBash(source: string, cwd: string): BashResult {
  const walk: Walk = { repo: new RepoState(), dir: cwd, trace: [], verdicts: [], vars: new Map() };
  walkSource(source, walk, 0);
  return { ...strictest(walk.verdicts), trace: walk.trace };
}
