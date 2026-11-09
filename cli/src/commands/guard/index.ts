import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { decideBash, type BashResult } from "./bash.ts";
import { decideTool, type HookInput } from "./decide.ts";
import type { Verdict } from "./verdict.ts";

const usage = `Usage: pipeline guard [--explain "<command>" [--cwd <dir>]]

Guardrail for a Claude Code PreToolUse hook. It reads the hook JSON on stdin and
prints a deny or ask decision with a reason. An allowed call prints nothing.

  --explain <command>  Print how the command parses and what the guard decides.
  --cwd <dir>          The directory --explain judges branches from. Defaults to the current one.`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("guard reads the PreToolUse hook JSON on stdin. Run `pipeline guard --help`.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function display(word: string): string {
  return word === "" || /[\s"'$`;&|()<>*?{}]/.test(word) ? `'${word.replaceAll("'", `'\\''`)}'` : word;
}

function explain(command: string, cwd: string): string {
  const result: BashResult = decideBash(command, cwd);
  const lines = [`Command: ${command}`, `Directory: ${cwd}`, "", "Parsed:"];
  if (result.trace.length === 0) lines.push("  (no commands)");
  result.trace.forEach((entry, index) => {
    lines.push(`  ${index + 1}. ${entry.words.map(display).join(" ")}`);
    if (entry.assignments.length > 0) lines.push(`     env: ${entry.assignments.join(" ")}`);
    lines.push(`     runs: ${entry.command.map(display).join(" ") || "(nothing)"}`);
    for (const found of entry.verdicts) lines.push(`     ${found.decision}: ${found.reason}`);
  });
  const reason = result.decision === "allow" ? "no rule matched" : result.reason;
  lines.push("", `Decision: ${result.decision} (${reason})`);
  return lines.join("\n");
}

function respond(found: Verdict): void {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: found.decision,
        permissionDecisionReason: `pipeline guard: ${found.reason}`,
      },
    }),
  );
}

const guard: Command = {
  name: "guard",
  summary: "Decide whether a Claude Code tool call is allowed, for a PreToolUse hook.",
  usage,
  async run(argv) {
    const { values } = parseArgs({
      args: argv,
      options: { explain: { type: "string" }, cwd: { type: "string" } },
    });
    if (values.explain !== undefined) {
      console.log(explain(values.explain, values.cwd ?? process.cwd()));
      return 0;
    }

    let input: HookInput;
    try {
      input = JSON.parse(await readStdin()) as HookInput;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("stdin is not valid hook JSON.", { cause: error });
      throw error;
    }
    if (typeof input !== "object" || input === null) throw new Error("stdin is not valid hook JSON.");

    const found = decideTool(input);
    if (found.decision !== "allow") respond(found);
    return 0;
  },
};

export default guard;
