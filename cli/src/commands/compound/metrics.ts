import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { CACHE_DIR, cachePath, fetchRepo, gh, GhError, readCache, repoOfRemote, type RepoData, writeCache } from "../../compound/github.ts";
import { metrics } from "../../compound/metrics.ts";
import { renderMetricsHtml } from "../../compound/metrics-html.ts";
import { primaryCheckout } from "../../run/log.ts";
import { excludeLocally } from "../../task/git.ts";
import { builtinConfig, loadConfig } from "../scan-zones/config.ts";

export const metricsUsage = `Usage: pipeline compound metrics [--repo <owner/name>]... [--since <date>] [--window <days>] [--offline] [--out <file.html>] [--json]

metrics reads each repo's merged PRs through \`gh api\`, the same fetch and cache as \`compound quality\`,
and writes one static HTML page of quality, human attention and efficiency, per repo and overall.
A number with no source in the PRs reads "no data".

Options:
  --repo <owner/name>  A GitHub repo to read, repeatable. Defaults to this checkout's origin.
  --since <date>       Only PRs merged on or after this date, as YYYY-MM-DD. Defaults to 30 days ago.
  --window <days>      How long after a merge a fix still counts against the PR. Defaults to 14.
  --offline            Read the last fetch of each repo from .pipeline/compound/github/ in place of GitHub.
  --out <file.html>    Where to write the page. Defaults to .pipeline/compound/metrics.html in this checkout.
  --json               Print the computed numbers as JSON in place of the path line.

Exit codes: 0 on success, 2 for bad usage, nothing to read, or gh unable to read a repo.`;

/**
 * Prints a usage error and returns its exit code
 */
function fail(message: string): number {
  console.error(`pipeline compound: ${message}`);
  return 2;
}

/**
 * A positive whole number option, or its default when absent
 */
function count(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`--${name} takes a positive whole number.`);
  return Number(value);
}

/**
 * A YYYY-MM-DD option as a time, its fallback when absent, or NaN when it is not a date
 */
function date(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
}

/**
 * The GitHub repo of a checkout's origin remote, or null
 */
function originRepo(checkout: string): string | null {
  const url = spawnSync("git", ["remote", "get-url", "origin"], { cwd: checkout, encoding: "utf8" });
  return url.status === 0 ? repoOfRemote(url.stdout) : null;
}

/**
 * Writes the page, keeping one inside the checkout's pipeline folder out of git
 *
 * A page there is local working state, like the fetches it came from.
 */
function writePage(checkout: string | null, file: string, html: string): string {
  const out = resolve(file);
  mkdirSync(dirname(out), { recursive: true });
  if (checkout !== null && out.startsWith(join(checkout, ".pipeline") + sep)) excludeLocally(checkout, `${relative(checkout, dirname(out))}/`, relative(checkout, out));
  writeFileSync(out, html);
  return out;
}

/**
 * Runs `pipeline compound metrics`
 */
export async function runMetrics(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        repo: { type: "string", multiple: true },
        since: { type: "string" },
        window: { type: "string" },
        offline: { type: "boolean" },
        out: { type: "string" },
        json: { type: "boolean" },
      },
    });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline compound --help".`);
  }
  const { values } = parsed;

  let windowDays: number;
  try {
    windowDays = count(values.window, 14, "window");
  } catch (error) {
    return fail((error as Error).message);
  }
  const now = new Date();
  const from = date(values.since, now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from)) return fail("--since takes a date as YYYY-MM-DD.");

  const checkout = primaryCheckout(resolve(process.cwd()));
  const own = checkout === null ? null : originRepo(checkout);
  const names = values.repo ?? (own === null ? [] : [own]);
  if (names.length === 0) return fail("this checkout has no GitHub origin, so name a repo with --repo <owner/name>.");
  const bad = names.find((name) => !/^[\w.-]+\/[\w.-]+$/.test(name));
  if (bad !== undefined) return fail(`--repo takes owner/name, not "${bad}".`);
  if (values.out === undefined && checkout === null) return fail("this is not a checkout, so name the page with --out <file.html>.");

  const repos: RepoData[] = [];
  for (const name of names) {
    if (values.offline) {
      const cached = checkout === null ? null : readCache(checkout, name);
      if (cached === null) return fail(`no saved fetch of ${name}${checkout === null ? "" : ` at ${cachePath(checkout, name)}`}, so run once without --offline.`);
      repos.push(cached);
      continue;
    }
    // A repo's own sensitive.yml applies only to the checkout it sits in, and other repos get the built-in packs.
    const config = checkout !== null && name === own ? loadConfig(checkout) : builtinConfig();
    try {
      const data = await fetchRepo(gh, name, new Date(from), config);
      if (checkout !== null) {
        excludeLocally(checkout, `${CACHE_DIR}/`, relative(checkout, cachePath(checkout, name)));
        writeCache(checkout, data);
      }
      repos.push(data);
    } catch (error) {
      if (error instanceof GhError) return fail(error.message);
      throw error;
    }
  }

  const report = metrics(repos, { windowDays, from });
  const file = values.out ?? join(checkout!, ".pipeline", "compound", "metrics.html");
  const page = writePage(checkout, file, renderMetricsHtml(report, now.toISOString().slice(0, 16).replace("T", " ") + " UTC"));
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`Wrote the metrics page to ${page}.`);
  return 0;
}
