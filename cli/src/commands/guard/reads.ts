import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseGlobal } from "./git.ts";
import { wordIsSensitive } from "./paths.ts";
import type { SimpleCommand } from "./shell.ts";
import { verdict, type Verdict } from "./verdict.ts";

/** Programs that read, copy, move, print, encode, open or send the files named in their arguments. */
const READERS = new Set([
  ...["cat", "tac", "head", "tail", "less", "more", "bat", "nl", "od", "hexdump", "xxd", "strings"],
  ...["grep", "egrep", "fgrep", "zgrep", "rg", "ag", "awk", "gawk", "sed", "cut", "sort", "uniq"],
  ...["diff", "cmp", "comm", "paste", "tr", "fold", "column", "jq", "yq", "pr", "fmt", "base64"],
  ...["cp", "mv", "ln", "install", "dd", "scp", "rsync", "tar", "zip", "gzip", "gunzip", "zcat"],
  ...["source", ".", "open", "vim", "vi", "view", "nano", "emacs", "code", "cursor", "subl"],
  ...["curl", "wget", "openssl", "ssh-add", "ssh-keygen", "gpg", "pbcopy", "xclip"],
]);

/** Search and edit tools take a pattern or script first, unless -e or -f supplies it. */
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "zgrep", "rg", "ag", "sed", "awk", "gawk"]);
const SUPPLIES_PATTERN = /^(?:-[a-zA-Z]*[ef][a-zA-Z]*|--regexp(?:=.*)?|--file(?:=.*)?|--expression(?:=.*)?)$/;

/** Git subcommands that print, stage or copy file contents. `status`, `check-ignore` and `ls-files` stay out. */
const GIT_READERS = new Set([
  ...["add", "show", "diff", "log", "blame", "annotate", "cat-file", "archive", "checkout"],
  ...["restore", "stash", "difftool", "format-patch", "apply", "mv", "whatchanged"],
]);

const MAX_LIST_BYTES = 64 * 1024;

function fileWords(path: string, dir: string): string[] {
  const absolute = resolve(dir, path);
  try {
    if (!existsSync(absolute) || statSync(absolute).size > MAX_LIST_BYTES) return [];
    return readFileSync(absolute, "utf8").split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

/** The names `xargs` would receive on stdin, as far as the command line shows them. */
function xargsInput(command: SimpleCommand, dir: string, unwrap: (words: string[]) => string[]): string[] {
  const words = command.inputs.flatMap((file) => fileWords(file, dir));
  const source = command.pipedFrom;
  if (source) {
    const argv = unwrap(source.words);
    if (basename(argv[0] ?? "") === "cat") words.push(...argv.slice(1).flatMap((file) => fileWords(file, dir)));
    words.push(...argv.slice(1), ...source.heredocs.flatMap((body) => body.split(/\s+/)));
  }
  return words;
}

/**
 * Denies a command that touches a secret path. Existence and ignore checks such as
 * `ls`, `test`, `stat`, `git status` and `git check-ignore` are not readers, so they pass.
 */
export function checkSecretReads(
  argv: string[],
  command: SimpleCommand,
  options: { dir: string; viaXargs: boolean; unwrap: (words: string[]) => string[] },
): Verdict[] {
  const { dir } = options;
  const program = basename(argv[0] ?? "");
  const args = argv.slice(1);
  const hits = command.inputs.filter((file) => wordIsSensitive(file, dir));

  if (READERS.has(program)) {
    let words = args;
    if (PATTERN_FIRST.has(program) && !args.some((arg) => SUPPLIES_PATTERN.test(arg))) {
      const index = args.findIndex((arg) => !arg.startsWith("-"));
      if (index !== -1) words = args.filter((_, i) => i !== index);
    }
    hits.push(...words.filter((word) => wordIsSensitive(word, dir)));
    if (options.viaXargs) {
      hits.push(...xargsInput(command, dir, options.unwrap).filter((word) => wordIsSensitive(word, dir)));
    }
  } else if (program === "git") {
    const { dir: gitDir, subcommand, rest } = parseGlobal(args, dir);
    if (subcommand !== undefined && GIT_READERS.has(subcommand)) {
      hits.push(...rest.filter((word) => wordIsSensitive(word, gitDir)));
    }
  }

  if (hits.length === 0) return [];
  return [
    verdict(
      "deny",
      "sensitive-path",
      `${program || "redirection"} on ${hits[0]} is denied because it holds secrets. Use .env.example for placeholders`,
    ),
  ];
}
