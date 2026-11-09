import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Command } from "./command.ts";

const commandsDir = new URL("./commands/", import.meta.url);

function wantsHelp(args: string[]): boolean {
  const { values } = parseArgs({
    args,
    options: { help: { type: "boolean", short: "h" } },
    allowPositionals: true,
    strict: false,
  });
  return values.help === true;
}

async function commandNames(): Promise<string[]> {
  const entries = await readdir(commandsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function loadCommand(name: string): Promise<Command> {
  const url = pathToFileURL(new URL(`${name}/index.ts`, commandsDir).pathname);
  const command = (await import(url.href)).default as Command | undefined;
  if (!command || command.name !== name || typeof command.run !== "function") {
    throw new Error(`commands/${name}/index.ts must default-export a command named "${name}".`);
  }
  return command;
}

function commandUsage(command: Command): string {
  return command.usage ?? `Usage: pipeline ${command.name} [options]\n\n${command.summary}`;
}

async function printHelp(names: string[]): Promise<void> {
  const commands = await Promise.all(names.map(loadCommand));
  const width = Math.max(...commands.map((command) => command.name.length));
  const lines = commands.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`);
  console.log(
    `Usage: pipeline <command> [options]\n\nCommands:\n${lines.join("\n")}\n\nRun "pipeline <command> --help" for a command's usage.`,
  );
}

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  const names = await commandNames();

  if (name === undefined || (name.startsWith("-") && wantsHelp([name]))) {
    await printHelp(names);
    return 0;
  }

  if (!names.includes(name)) {
    console.error(`pipeline: unknown command "${name}". Run "pipeline --help" to list commands.`);
    return 1;
  }

  const command = await loadCommand(name);
  if (wantsHelp(rest)) {
    console.log(commandUsage(command));
    return 0;
  }
  return command.run(rest);
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`pipeline: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
});
