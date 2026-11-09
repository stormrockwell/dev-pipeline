import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { loadConfig } from "../scan-zones/config.ts";
import { labelDefinitions } from "./labels.ts";
import { applyCommands, renderRuleset } from "./ruleset.ts";

const usage = `Usage: pipeline github <ruleset | labels | commands> [options]

Renders the GitHub side of the pipeline from a repo's .pipeline/sensitive.yml. Nothing here calls the
GitHub API, and applying the output is a command that a human runs.

  ruleset    Print the repository ruleset as JSON: path based required reviewers from the zone
             rules, required status checks, squash only merges and no force pushes.
  labels     Print the risk:* and zone:* label definitions as JSON.
  commands   Print the gh commands that create the labels and the ruleset. Needs --repo.

Options:
  --path <dir>      Repo that holds .pipeline/sensitive.yml. Defaults to the current directory.
  --out <file>      Write ruleset or labels to a file instead of printing them.
  --team-id <n>     Team id to render into the ruleset. The printed commands look it up instead.
  --repo <o/r>      Repository the commands target (commands only).
  --team <slug>     Zone approvers team slug (commands only). Defaults to zone-approvers.
  --ruleset <file>  Ruleset file the commands read (commands only). Defaults to ruleset.json.

Required reviewers need an organization repository on GitHub Pro, Team or Enterprise, or a public one.
The install steps are in docs/github.md.

Exit codes: 0 on success, 2 for bad usage or an invalid sensitive.yml.`;

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
        path: { type: "string" },
        out: { type: "string" },
        "team-id": { type: "string" },
        repo: { type: "string" },
        team: { type: "string" },
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
      ...applyCommands({ repo: values.repo, team: values.team ?? "zone-approvers", rulesetFile }),
    ];
    console.log(lines.join("\n"));
    return 0;
  }

  const teamId = values["team-id"] === undefined ? 0 : Number(values["team-id"]);
  if (!Number.isInteger(teamId) || teamId < 0) return fail("--team-id must be a whole number.");
  let ruleset;
  try {
    ruleset = renderRuleset(loadConfig(resolve(values.path ?? process.cwd())), { teamId });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  emit(JSON.stringify(ruleset, null, 2), values.out);
  return 0;
}

const command: Command = {
  name: "github",
  summary: "Render the GitHub ruleset and labels from sensitive.yml.",
  usage,
  run,
};

export default command;
