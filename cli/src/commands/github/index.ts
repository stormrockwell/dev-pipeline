import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { labelDefinitions } from "./labels.ts";
import { applyCommands, renderRuleset } from "./ruleset.ts";

const usage = `Usage: pipeline github <ruleset | labels | commands> [options]

Renders the GitHub side of the pipeline. Nothing here calls the GitHub API, and applying the output is a
command that a human runs.

  ruleset    Print the repository ruleset as JSON: the floor and risk-gate status checks, squash only
             merges, no force pushes and no bypass actors. The peer approval counts live in risk-gate,
             because a ruleset cannot key approvals on a label.
  labels     Print the risk:* and zone:* label definitions as JSON.
  commands   Print the gh commands that create the labels and the ruleset. Needs --repo.

Options:
  --out <file>      Write ruleset or labels to a file instead of printing them.
  --repo <o/r>      Repository the commands target (commands only).
  --ruleset <file>  Ruleset file the commands read (commands only). Defaults to ruleset.json.

Rulesets need a public repository or a plan that includes them, such as GitHub Pro.
The install steps are in docs/github.md.

Exit codes: 0 on success, 2 for bad usage.`;

const SUBCOMMANDS = ["ruleset", "labels", "commands"];

function fail(message: string): number {
  console.error(`pipeline github: ${message}`);
  return 2;
}

function emit(text: string, out: string | undefined): void {
  if (out === undefined) {
    console.log(text);
    return;
  }
  const file = resolve(out);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${text}\n`);
  console.log(`wrote ${out}`);
}

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        out: { type: "string" },
        repo: { type: "string" },
        ruleset: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline github --help".`);
  }
  const { values, positionals } = parsed;
  const [subcommand, ...extra] = positionals;
  if (!subcommand || !SUBCOMMANDS.includes(subcommand) || extra.length > 0) {
    return fail(`give one of ${SUBCOMMANDS.join(", ")}. Run "pipeline github --help".`);
  }

  if (subcommand === "labels") {
    emit(JSON.stringify(labelDefinitions(), null, 2), values.out);
    return 0;
  }

  if (subcommand === "commands") {
    if (!values.repo || !/^[\w.-]+\/[\w.-]+$/.test(values.repo)) return fail("commands needs --repo <owner>/<name>.");
    const rulesetFile = values.ruleset ?? "ruleset.json";
    const lines = [
      "# Review these commands, then run them from a shell that is signed in to gh as a repo admin.",
      `# 1. Render the ruleset: pipeline github ruleset --out ${rulesetFile}`,
      "",
      ...applyCommands({ repo: values.repo, rulesetFile }),
    ];
    console.log(lines.join("\n"));
    return 0;
  }

  const ruleset = renderRuleset();
  emit(JSON.stringify(ruleset, null, 2), values.out);
  return 0;
}

const command: Command = {
  name: "github",
  summary: "Render the GitHub ruleset and labels.",
  usage,
  run,
};

export default command;
