import { decideBash } from "./bash.ts";
import { checkToolPaths, type ToolInput } from "./paths.ts";
import { ALLOW, type Verdict } from "./verdict.ts";

export type HookInput = ToolInput;

/** Decides one PreToolUse hook call. */
export function decideTool(input: HookInput): Verdict {
  const cwd = input.cwd ?? process.cwd();
  if (input.tool_name === "Bash") {
    const command = input.tool_input?.command;
    if (typeof command !== "string") return ALLOW;
    const { decision, rule, reason } = decideBash(command, cwd);
    return { decision, rule, reason };
  }
  return checkToolPaths(input, cwd) ?? ALLOW;
}
