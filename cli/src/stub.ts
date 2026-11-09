import type { Command } from "./command.ts";

// Exit code 2 separates "not built yet" from a command that ran and failed with 1.
export function stub(name: string, summary: string): Command {
  return {
    name,
    summary,
    async run() {
      console.log(`pipeline ${name}: not built yet.`);
      return 2;
    },
  };
}
