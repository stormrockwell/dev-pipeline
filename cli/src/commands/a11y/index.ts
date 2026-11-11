import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { appendEntry } from "../../ledger/ledger.ts";
import { BASELINE_PATH, readBaseline } from "./baseline.ts";
import { DEFAULT_TARGET, readA11yProfile, resolveUrls, TARGET_TAGS } from "./profile.ts";
import { type AxeRunner, openPlaywrightRunner } from "./runner.ts";
import { type ScanOutcome, scanPages } from "./run.ts";

const usage = `Usage: pipeline a11y --base-url <url> [options]

Scan pages with axe-core in a headless browser, and fail on any violation the baseline does not hold.
A violation is keyed by its rule, its page path and its selector, so editing the page's text leaves
an old violation where it was. The scan fails closed: a site that cannot be reached, a page that does
not answer 2xx and a browser that cannot start all exit 1.

Playwright is optional. When it is missing the command prints how to install it.

Options:
  --base-url <url>    The running site. Defaults to accessibility.base_url in .pipeline/profile.yml.
  --url <path>        A page to scan, such as one the work order names. Repeat for more.
                      The profile's accessibility.urls are scanned too, or / when there are none.
  --target <name>     ${Object.keys(TARGET_TAGS).join(", ")}. Defaults to the profile's target, then ${DEFAULT_TARGET}.
  --baseline <file>   Defaults to ${BASELINE_PATH}.
  --update-baseline   Record what the scan found as the accepted state. Entries of pages not scanned stay.
                      The baseline sits under .pipeline/, so a person reviews every change to it.
  --path <dir>        Repo to read the profile and baseline from. Defaults to the current directory.
  --work-order <file> With --task, record the axe gate result in the work order's ledger.
  --task <id>         The task whose axe gate to record.
  --timeout <secs>    Page load limit. Defaults to 30.
  --json              Print the result as JSON.
  -h, --help          Show this help.

Exit codes: 0 when no new violation appeared or the baseline was recorded, 1 on a new violation or a failed scan, 2 for bad usage.`;

const defaultTimeoutSeconds = 30;

function fail(message: string): number {
  console.error(`pipeline a11y: ${message}`);
  return 2;
}

/**
 * Prints the outcome as lines for a person
 */
function printText(outcome: ScanOutcome, target: string, baselinePath: string, hadBaseline: boolean): void {
  const { diff, scanned } = outcome;
  console.log(`a11y: ${scanned.length} ${scanned.length === 1 ? "page" : "pages"} scanned against ${target}`);
  if (outcome.recorded) {
    console.log(`recorded ${diff.added.length + diff.kept.length} violations in ${baselinePath}`);
    return;
  }
  for (const violation of diff.added) console.log(`new   ${violation.rule}  ${violation.url}  ${violation.selector}  (${violation.impact}) ${violation.help}`);
  console.log(`\na11y: ${diff.added.length} new, ${diff.kept.length} in the baseline, ${diff.fixed.length} fixed since it was recorded`);
  if (!hadBaseline && diff.added.length > 0) console.log(`no baseline at ${baselinePath}, so every violation counts as new. Record the current state with --update-baseline.`);
  if (diff.fixed.length > 0) console.log("fixed entries stay in the baseline until --update-baseline records the scan.");
}

/**
 * Runs the command with Playwright, or with the runner a test hands in
 */
export async function runA11y(argv: string[], runner?: AxeRunner): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "base-url": { type: "string" },
        url: { type: "string", multiple: true },
        target: { type: "string" },
        baseline: { type: "string" },
        "update-baseline": { type: "boolean" },
        path: { type: "string" },
        "work-order": { type: "string" },
        task: { type: "string" },
        timeout: { type: "string" },
        json: { type: "boolean" },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    return fail(`${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
  }

  const dir = resolve(values.path ?? process.cwd());
  let profile;
  try {
    profile = readA11yProfile(dir);
  } catch (error) {
    return fail(`.pipeline/profile.yml: ${error instanceof Error ? error.message : String(error)}`);
  }
  const target = values.target ?? profile.target;
  const tags = TARGET_TAGS[target];
  if (!tags) return fail(`unknown target "${target}". Use one of ${Object.keys(TARGET_TAGS).join(", ")}.`);
  const base = values["base-url"] ?? profile.baseUrl;
  if (!base) return fail("no site to scan. Pass --base-url <url> for the running site, or set accessibility.base_url in .pipeline/profile.yml.");
  const timeout = values.timeout === undefined ? defaultTimeoutSeconds : Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) return fail(`--timeout needs a positive number of seconds, got "${values.timeout}".`);
  if (Boolean(values["work-order"]) !== Boolean(values.task)) return fail("--work-order and --task go together.");

  let urls;
  try {
    urls = resolveUrls(base, values.url ?? [], profile.urls);
  } catch {
    return fail(`"${base}" or one of the pages is not a valid URL.`);
  }

  const baselinePath = resolve(dir, values.baseline ?? BASELINE_PATH);
  let outcome: ScanOutcome | undefined;
  let problem: string | undefined;
  let hadBaseline = false;
  const open = runner === undefined;
  try {
    const baseline = readBaseline(baselinePath);
    hadBaseline = baseline !== null;
    const active = runner ?? (await openPlaywrightRunner(timeout));
    try {
      outcome = await scanPages({ runner: active, urls, tags, target, baseline, baselinePath, record: values["update-baseline"] === true });
    } finally {
      if (open) await active.close();
    }
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }

  const ok = outcome !== undefined && (outcome.recorded || outcome.diff.added.length === 0);
  if (values.json) {
    console.log(JSON.stringify({ ok, target, urls, error: problem ?? null, new: outcome?.diff.added ?? [], kept: outcome?.diff.kept.length ?? 0, fixed: outcome?.diff.fixed ?? [], recorded: outcome?.recorded ?? false }, null, 2));
  } else if (outcome) {
    printText(outcome, target, baselinePath, hadBaseline);
  } else {
    console.error(`pipeline a11y: scan failed, and a scan that did not run passes nothing. ${problem}`);
  }

  if (values["work-order"] && values.task && !outcome?.recorded) {
    const note = outcome ? `${outcome.diff.added.length} new violations against ${target}` : `scan failed: ${problem}`;
    appendEntry(resolve(values["work-order"]), { kind: "gate", at: new Date().toISOString(), task: values.task, gate: "axe", result: ok ? "pass" : "fail", note });
  }
  return ok ? 0 : 1;
}

const command: Command = {
  name: "a11y",
  summary: "Scan pages with axe-core and fail on violations the baseline lacks.",
  usage,
  run: (argv) => runA11y(argv),
};

export default command;
