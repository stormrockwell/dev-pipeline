import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { collectRange, collectStaged, collectTree, type Collected } from "./collect.ts";
import { loadConfig } from "./config.ts";
import { buildReport, formatJson, formatText, type Mode } from "./report.ts";
import { scanFile } from "./scan.ts";

const usage = `Usage: pipeline scan-zones [--staged | --range <from>..<to>] [--path <dir>] [--json]

Finds code that needs a human reviewer. A file is in a zone when its path matches a path rule or a line
matches a content signal. With no mode, every file under --path is scanned.

Modes:
  --staged               Scan the lines added by the staged diff.
  --range <from>..<to>   Scan the lines added between two commits.

Options:
  --path <dir>           Directory to scan, or the repo to diff. Defaults to the current directory.
  --json                 Print the report as JSON.

Rules come from .pipeline/sensitive.yml in the repo. Without that file the built-in WordPress and Node
packs apply. Removed lines that matched a signal are listed first, because deleting a capability or nonce
check weakens a control. The schema is in docs/zones.md.

Exit codes: 0 when the scan ran, 2 for bad usage or an invalid sensitive.yml. Zones are not failures.`;

function fail(message: string): number {
  console.error(`pipeline scan-zones: ${message}`);
  return 2;
}

async function run(argv: string[]): Promise<number> {
  let options;
  try {
    options = parseArgs({
      args: argv,
      options: {
        staged: { type: "boolean" },
        range: { type: "string" },
        path: { type: "string" },
        json: { type: "boolean" },
      },
      allowPositionals: false,
    }).values;
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline scan-zones --help".`);
  }
  if (options.staged && options.range !== undefined) return fail("choose at most one of --staged and --range.");

  const dir = resolve(options.path ?? process.cwd());
  let mode: Mode = "tree";
  let collected: Collected;
  if (options.staged || options.range !== undefined) {
    mode = options.staged ? "staged" : "range";
    const result = options.staged ? collectStaged(dir) : collectRange(dir, options.range!);
    if (!result.ok) return fail(result.error);
    collected = result.collected;
  } else {
    try {
      collected = collectTree(dir);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  let config;
  try {
    config = loadConfig(collected.root);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const report = buildReport(mode, config, collected.inputs.map((input) => scanFile(config, input)));
  console.log(options.json ? formatJson(report) : formatText(report));
  return 0;
}

const command: Command = {
  name: "scan-zones",
  summary: "Find files and lines that fall in human review zones.",
  usage,
  run,
};

export default command;
