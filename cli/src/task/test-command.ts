import { decideBash } from "../commands/guard/bash.ts";
import { parseShell } from "../commands/guard/shell.ts";

export interface TestCommand {
  argv: string[];
  env: Record<string, string>;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

/**
 * Quotes a word for the guard, so an argument such as ";" reads as a word and never as an operator
 */
function quote(word: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The argv and environment for a task's recorded test command, with extra words appended
 *
 * `pipeline tdd` sits under a broad `pipeline *` permission, so it runs only one plain command and
 * only what `pipeline guard` allows. That keeps it from running a push, a force or a remote command
 * that the session's own rules would stop.
 */
export function testCommand(source: string, extra: string[], cwd: string): TestCommand {
  const commands = parseShell(source);
  const [only] = commands;
  const plain =
    commands.length === 1 &&
    only !== undefined &&
    only.pipedFrom === undefined &&
    only.heredocs.length === 0 &&
    only.inputs.length === 0 &&
    !only.words.some((word) => word.includes("$(…)") || word.includes("`…`"));
  if (!plain) throw new Error(`the test command must be one plain command with no pipes, chains or substitutions, and "${source}" is not`);

  const env: Record<string, string> = {};
  const words = [...only.words];
  while (words.length > 0 && ASSIGNMENT.test(words[0]!)) {
    const [, name, value] = ASSIGNMENT.exec(words.shift()!)!;
    env[name!] = value!;
  }
  if (words.length === 0) throw new Error(`the test command "${source}" names no program`);

  const argv = [...words, ...extra];
  const decision = decideBash([...Object.entries(env).map(([name, value]) => `${name}=${quote(value)}`), ...argv.map(quote)].join(" "), cwd);
  if (decision.decision !== "allow") throw new Error(`pipeline guard would ${decision.decision === "deny" ? "deny" : "ask about"} "${argv.join(" ")}": ${decision.reason}`);
  return { argv, env };
}
