import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { collectFiles, collectRange, collectStaged, type Collected } from "../scan-zones/collect.ts";
import { loadConfig } from "../scan-zones/config.ts";
import { reachFinder } from "./reach.ts";
import { classifyInputs, type Classification, type Reason } from "./tier.ts";

const usage = `Usage: pipeline classify (<file>... | --staged | --range <from>..<to>) [--path <dir>] [--no-reach] [--json]

Assigns a risk tier from file types, human review zones and guardrail paths.

  T0 Docs          Markdown and other documentation only.
  T1 Presentation  CSS, SCSS, static markup and static assets.
  T2 Logic         Code and configuration, and templates that echo variables.
  T3 Sensitive     Any zone match: a path rule, a content signal on an added line, or a removed
                   signal such as a deleted capability check, or a changed function that zone code
                   calls (reach). Guardrail paths are T3.

Input:
  <file>...              Classify these paths. Content is read from the working tree.
  --staged               Classify the staged diff.
  --range <from>..<to>   Classify the net change between two commits.

Options:
  --path <dir>           Directory that holds the files, or the repo to diff. Defaults to the current
                         directory. Rules come from .pipeline/sensitive.yml there, or the built-in packs.
  --no-reach             Skip the reach check. By default, a changed function that zone code calls
                         raises the change to T3 with those zones, found by a text search of the repo.
  --json                 Print the result as JSON.

The rules only raise a tier. Lowering a tier is a human action and is not offered here. A tier is the
highest tier of any file. Zone rules are documented in docs/zones.md.

Exit codes: 0 when the change was classified, 2 for bad usage or an invalid sensitive.yml.`;

const MAX_TEXT_REASONS = 12;

function fail(message: string): number {
  console.error(`pipeline classify: ${message}`);
  return 2;
}

function where(reason: Reason): string {
  if (reason.file === null) return "";
  return reason.line ? `${reason.file}:${reason.line}` : reason.file;
}

function label(reason: Reason): string {
  if (!reason.zone) return reason.rule;
  const prefix = reason.rule === "removed-signal" ? "removed " : reason.rule === "reach" ? "reach " : "";
  return `${prefix}zone:${reason.zone}`;
}

function formatText(result: Classification): string {
  const out = [`Tier: ${result.tier} (${result.name})`, `Zones: ${result.zones.length > 0 ? result.zones.join(", ") : "none"}`, "", "Reasons:"];
  for (const reason of result.reasons.slice(0, MAX_TEXT_REASONS)) {
    out.push(`  ${[where(reason), label(reason), reason.detail].filter(Boolean).join("  ")}`);
  }
  if (result.reasons.length > MAX_TEXT_REASONS) out.push(`  ... and ${result.reasons.length - MAX_TEXT_REASONS} more, listed in --json`);
  return out.join("\n");
}

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        staged: { type: "boolean" },
        range: { type: "string" },
        path: { type: "string" },
        "no-reach": { type: "boolean" },
        json: { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline classify --help".`);
  }
  const { values, positionals } = parsed;

  const modes = [values.staged === true, values.range !== undefined, positionals.length > 0].filter(Boolean).length;
  if (modes === 0) return fail("give files, --staged or --range <from>..<to>.");
  if (modes > 1) return fail("choose one of files, --staged and --range.");

  const dir = resolve(values.path ?? process.cwd());
  let collected: Collected;
  if (values.staged || values.range !== undefined) {
    const result = values.staged ? collectStaged(dir) : collectRange(dir, values.range!);
    if (!result.ok) return fail(result.error);
    collected = result.collected;
  } else {
    const files = positionals.map((path) => (isAbsolute(path) ? relative(dir, path) : path).split("\\").join("/"));
    collected = collectFiles(dir, files);
  }

  let result: Classification;
  try {
    result = classifyInputs(loadConfig(collected.root), collected.inputs, values["no-reach"] ? undefined : reachFinder(collected.root));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  console.log(values.json ? JSON.stringify(result, null, 2) : formatText(result));
  return 0;
}

const command: Command = {
  name: "classify",
  summary: "Classify a change by risk tier, T0 to T3.",
  usage,
  run,
};

export default command;
