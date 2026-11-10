import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { parseYaml, type YamlValue } from "../scan-zones/yaml.ts";
import { type Commit, entriesFor, nextVersion, renderEntries, writeChangelog } from "./changelog.ts";
import { findLocations, type Location, setVersion } from "./locations.ts";

const usage = `Usage: pipeline version-sync [--dir <repo>] [--json]
       pipeline version-sync set <version> [--dir <repo>]
       pipeline version-sync changelog --range <base>..<head> [--dir <repo>] [--write]

Keeps every version string in a repo in agreement: plugin and theme headers, their version
constants, the readme.txt stable tag, and the version in package.json and composer.json.

  (no verb)   Check that every location holds the same version.
  set         Write one version to every location.
  changelog   List the Keep a Changelog entries the conventional commits in the range call for,
              and the SemVer bump the next release takes. With --write it adds them under
              Unreleased in CHANGELOG.md. Only a distributed project keeps a changelog, so it
              does nothing unless .pipeline/profile.yml says \`distributed: true\`.

Options:
  --dir <repo>   The repo to read. Defaults to the current directory.
  --json         Print the locations as JSON.

Exit codes: 0 when the versions agree or the command did its work, 1 when versions disagree,
2 for bad usage.`;

function fail(message: string): number {
  console.error(`pipeline version-sync: ${message}`);
  return 2;
}

function describe(location: Location): string {
  return `${location.file}:${location.line}  ${location.kind}  ${location.version}`;
}

/**
 * Whether the repo's profile marks it distributed, meaning installed on more than one site
 */
export function isDistributed(dir: string): boolean {
  const path = join(dir, ".pipeline/profile.yml");
  if (!existsSync(path)) return false;
  const profile = parseYaml(readFileSync(path, "utf8")) as { [key: string]: YamlValue } | null;
  const project = profile?.project as { [key: string]: YamlValue } | undefined;
  return project?.distributed === true;
}

/**
 * The commits in a range, oldest first, leaving out merges
 */
function commitsIn(dir: string, range: string): Commit[] {
  const result = spawnSync("git", ["log", "--reverse", "--no-merges", "--format=%s%x00%b%x1e", range, "--"], { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git log ${range} failed: ${(result.stderr ?? "").trim()}`);
  return result.stdout
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [subject, body] = record.split("\x00");
      return { subject: subject ?? "", body: body ?? "" };
    });
}

function check(dir: string, json: boolean): number {
  const locations = findLocations(dir);
  const versions = [...new Set(locations.map((location) => location.version))];
  if (json) {
    console.log(JSON.stringify({ agree: versions.length <= 1, versions, locations }, null, 2));
    return versions.length <= 1 ? 0 : 1;
  }
  if (locations.length === 0) {
    console.log("version-sync: no version strings found, so there is nothing to keep in step");
    return 0;
  }
  if (versions.length === 1) {
    console.log(`version-sync: ${locations.length} locations agree on ${versions[0]}`);
    return 0;
  }
  console.log(["version-sync: the versions disagree", ...locations.map((location) => `- ${describe(location)}`)].join("\n"));
  return 1;
}

function changelog(dir: string, range: string | undefined, write: boolean): number {
  if (range === undefined || !/^[^\s.][^\s]*\.\.[^\s.][^\s]*$/.test(range)) return fail("changelog needs --range <base>..<head>.");
  if (!isDistributed(dir)) {
    console.log("version-sync: the profile does not mark this project distributed, so it keeps no changelog");
    return 0;
  }
  const entries = entriesFor(commitsIn(dir, range));
  const current = findLocations(dir)[0]?.version ?? null;
  const next = current === null ? null : nextVersion(current, entries.bump);
  const release = entries.bump === "none" ? "Release   no bump, nothing a user notices changed" : `Release   ${entries.bump} bump${next ? `, ${current} to ${next}` : ""}`;
  if (entries.bump === "none") {
    console.log(`version-sync: no changelog entries in ${range}\n${release}`);
    return 0;
  }
  if (!write) {
    console.log(`${renderEntries(entries)}\n${release}`);
    return 0;
  }
  const added = writeChangelog(dir, entries);
  console.log(added.length > 0 ? `version-sync: added ${added.length} entries under Unreleased in CHANGELOG.md\n${release}` : `version-sync: CHANGELOG.md already lists every entry\n${release}`);
  return 0;
}

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { dir: { type: "string" }, json: { type: "boolean" }, range: { type: "string" }, write: { type: "boolean" } }, allowPositionals: true });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline version-sync --help".`);
  }
  const { values, positionals } = parsed;
  const dir = resolve(values.dir ?? process.cwd());
  if (!existsSync(dir)) return fail(`no directory at ${dir}.`);
  const [verb, ...rest] = positionals;

  if (verb === undefined) return check(dir, values.json === true);
  if (verb === "changelog") return rest.length === 0 ? changelog(dir, values.range, values.write === true) : fail("changelog takes no other words.");
  if (verb === "set") {
    const version = rest[0];
    if (rest.length !== 1 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version!)) return fail("set needs one version such as 1.4.0.");
    const locations = setVersion(dir, version!);
    if (locations.length === 0) return fail("no version strings found to set.");
    console.log([`version-sync: set ${locations.length} locations to ${version}`, ...locations.map((location) => `- ${describe(location)}`)].join("\n"));
    return 0;
  }
  return fail(`unknown verb "${verb}". Run "pipeline version-sync --help".`);
}

const command: Command = {
  name: "version-sync",
  summary: "Check or set every version string, and write changelog entries from conventional commits.",
  usage,
  run,
};

export default command;
