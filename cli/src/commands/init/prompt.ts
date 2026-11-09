import { createInterface } from "node:readline/promises";
import type { Prompt, PromptInfo } from "./questions.ts";

function label(info: PromptInfo): string {
  const choices = info.choices ? ` [${info.choices.join(" / ")}]` : "";
  const fallback = info.default ? ` (${info.default})` : "";
  return `${info.text}${choices}${fallback} `;
}

// Asks on the terminal, one line per answer. An empty reply takes the default.
export function terminalPrompt(): { prompt: Prompt; close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    prompt: (info) => rl.question(label(info)),
    close: () => rl.close(),
  };
}
