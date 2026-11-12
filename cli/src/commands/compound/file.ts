import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gh, GhError, ghPost, repoOfRemote } from "../../compound/github.ts";
import {
  denylist,
  efficiencyLesson,
  FINDINGS,
  fileLesson,
  issueBody,
  type IssueApi,
  leak,
  type Lesson,
  LESSONS,
  PIPELINE_REPO,
  qualityLesson,
  repeatBody,
  rowKey,
  STANDARDS_REPO,
  targetProblem,
} from "../../compound/propose.ts";
import type { QualityReport } from "../../compound/quality.ts";
import type { EfficiencyReport } from "../../run/efficiency.ts";
import { primaryCheckout } from "../../run/log.ts";
import { excludeLocally } from "../../task/git.ts";
import { pipelineVersion } from "../gate-record/record.ts";

export const FILED = ".pipeline/compound/filed.json";
const QUALITY_REPORT = ".pipeline/compound/quality.json";
const EFFICIENCY_REPORT = ".pipeline/compound/efficiency.json";

export const fileUsage = `       pipeline compound file --class <fingerprint> --lesson <lesson> --becomes <text> [--to pipeline|standards] [--repo <owner/name>] [--report <file>] [--dry-run]
       pipeline compound file --finding <finding> --target <name> --becomes <text> [--to pipeline|standards] [--repo <owner/name>] [--report <file>] [--dry-run]

file sends one lesson the developer picked to the pipeline repo (${PIPELINE_REPO}) or the
standards repo (${STANDARDS_REPO}) as an issue carrying a hidden fingerprint of its class. When
an open issue already carries it, a comment raises its count instead, and at 3 the class is ready
for a PR. The issue holds only the class's axis, area, owner, counts and hints, or the finding and
the pipeline part it changes, plus the --becomes sentence, which is refused when it holds a link,
a repo name, a path, code or a quote from the local reports. The source PRs are kept in ${FILED}.

  --class <fingerprint>  a missed class from the quality report, such as q-9ecbaa070225
  --lesson <lesson>      ${Object.keys(LESSONS).join(", ")}, or the start of the lesson table's row
  --finding <finding>    ${Object.keys(FINDINGS).join(", ")}, or the start of the finding table's row
  --target <name>        the part the change lands in: dev-pipeline:<skill or agent>, pipeline <command> or hooks
  --becomes <text>       one sentence in general words on what the lesson becomes
  --to <repo>            pipeline (the default) or standards
  --repo <owner/name>    a fork to file on in place of --to's repo
  --report <file>        the half's report. Defaults to ${QUALITY_REPORT} or ${EFFICIENCY_REPORT}
  --dry-run              print what would be sent, and send nothing`;

/**
 * The local record of what was filed, with the client links that stay on this machine
 */
interface FiledRecord {
  version: 1;
  lessons: { fingerprint: string; repo: string; issue: number; url: string; count: number; refs: string[]; links: string[]; to: string | null; at: string }[];
}

/**
 * Prints a usage error and returns its exit code
 */
function fail(message: string): number {
  console.error(`pipeline compound file: ${message}`);
  return 2;
}

/**
 * Reads a JSON file, or null when it is missing or broken
 */
function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * The plugin's skills and agents when the plugin sits beside the CLI, and the CLI's commands
 */
function components(): { plugin: string[] | null; commands: string[] } {
  const plugin = fileURLToPath(new URL("../../../../plugin/", import.meta.url));
  const commands = readdirSync(fileURLToPath(new URL("../", import.meta.url)), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (!existsSync(join(plugin, "skills"))) return { plugin: null, commands };
  const skills = readdirSync(join(plugin, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const agents = existsSync(join(plugin, "agents")) ? readdirSync(join(plugin, "agents")).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)) : [];
  return { plugin: [...skills, ...agents].map((name) => `dev-pipeline:${name}`), commands };
}

/**
 * The GitHub repo of a checkout's origin remote, or null
 */
function originRepo(checkout: string): string | null {
  const url = spawnSync("git", ["remote", "get-url", "origin"], { cwd: checkout, encoding: "utf8" });
  return url.status === 0 ? repoOfRemote(url.stdout) : null;
}

/**
 * Whether the lesson brings evidence the local record has not already sent to this repo
 */
function alreadySent(record: FiledRecord, repo: string, lesson: Lesson): FiledRecord["lessons"][number] | null {
  const earlier = record.lessons.filter((entry) => entry.fingerprint === lesson.fingerprint && entry.repo === repo);
  const last = earlier.at(-1);
  if (!last) return null;
  if (lesson.half === "quality") {
    const sent = new Set(earlier.flatMap((entry) => entry.refs));
    return lesson.refs.length > 0 && lesson.refs.every((ref) => sent.has(ref)) ? last : null;
  }
  return lesson.to !== null && last.to !== null && lesson.to <= last.to ? last : null;
}

/**
 * Runs `pipeline compound file`
 */
export async function runFile(argv: string[], api: IssueApi = { get: gh, post: ghPost }): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        class: { type: "string" },
        lesson: { type: "string" },
        finding: { type: "string" },
        target: { type: "string" },
        becomes: { type: "string" },
        to: { type: "string" },
        repo: { type: "string" },
        report: { type: "string" },
        "dry-run": { type: "boolean" },
      },
    });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline compound --help".`);
  }
  const { values } = parsed;
  if ((values.class === undefined) === (values.finding === undefined)) return fail("name one lesson, a missed class with --class or an efficiency finding with --finding.");
  if (values.becomes === undefined) return fail("--becomes is required, one sentence in general words on what the lesson becomes.");
  if (values.to !== undefined && values.to !== "pipeline" && values.to !== "standards") return fail(`--to takes pipeline or standards, not "${values.to}".`);
  if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo)) return fail(`--repo takes owner/name, not "${values.repo}".`);
  const repo = values.repo ?? (values.to === "standards" ? STANDARDS_REPO : PIPELINE_REPO);

  const checkout = primaryCheckout(resolve(process.cwd()));
  if (checkout === null) return fail(`${process.cwd()} is not inside a git repo.`);
  const quality = values.class !== undefined ? readJson<QualityReport>(resolve(values.report ?? QUALITY_REPORT)) : readJson<QualityReport>(resolve(QUALITY_REPORT));
  const efficiency = values.finding !== undefined ? readJson<EfficiencyReport>(resolve(values.report ?? EFFICIENCY_REPORT)) : readJson<EfficiencyReport>(resolve(EFFICIENCY_REPORT));
  const own = originRepo(checkout);
  const deny = denylist(quality, efficiency, own === null ? [] : [own], [PIPELINE_REPO, STANDARDS_REPO, repo]);

  let lesson: Lesson | string;
  if (values.class !== undefined) {
    if (quality === null) return fail(`no quality report at ${values.report ?? QUALITY_REPORT}, so run "pipeline compound quality --out ${QUALITY_REPORT}" first.`);
    const key = rowKey(LESSONS, values.lesson ?? "");
    if (key === null) return fail(`--lesson takes ${Object.keys(LESSONS).join(", ")}, or the start of a row of the lesson table, such as "${LESSONS.sensitive}".`);
    lesson = qualityLesson(quality, values.class, key, values.becomes, deny);
  } else {
    if (efficiency === null) return fail(`no efficiency report at ${values.report ?? EFFICIENCY_REPORT}, so run "pipeline compound efficiency --out ${EFFICIENCY_REPORT}" first.`);
    const key = rowKey(FINDINGS, values.finding!);
    if (key === null) return fail(`--finding takes ${Object.keys(FINDINGS).join(", ")}, or the start of a row of the finding table, such as "${FINDINGS.sequence}".`);
    const target = (values.target ?? "").trim();
    const problem = targetProblem(target, components());
    if (problem) return fail(`${problem}.`);
    lesson = efficiencyLesson(efficiency, key, target, values.becomes, deny);
  }
  if (typeof lesson === "string") return fail(`${lesson}.`);

  const version = pipelineVersion();
  const record = readJson<FiledRecord>(join(checkout, FILED)) ?? { version: 1, lessons: [] };
  const known = record.lessons.filter((entry) => entry.fingerprint === lesson.fingerprint && entry.repo === repo).at(-1) ?? null;
  // Every text that leaves the machine passes the same check, so a fault in how it is built cannot leak.
  for (const text of [lesson.title, issueBody(lesson, version, known?.issue ?? null), repeatBody(lesson, 2)]) {
    const leaked = leak(text, deny);
    if (leaked) return fail(`refused, because ${leaked}.`);
  }

  const sent = alreadySent(record, repo, lesson);
  if (sent) {
    console.log(`Already counted ${lesson.fingerprint} from this evidence on ${sent.url}, so nothing ${values["dry-run"] ? "would be" : "was"} sent.`);
    return 0;
  }

  if (values["dry-run"]) {
    console.log(
      [
        `Dry run, nothing was sent. On ${repo} this opens the issue below, or adds a comment raising the count when an open issue carries ${lesson.fingerprint}.`,
        "",
        `Title: ${lesson.title}`,
        "",
        issueBody(lesson, version, null),
      ].join("\n"),
    );
    return 0;
  }

  let filed;
  try {
    filed = await fileLesson(api, repo, lesson, version, known?.issue ?? null);
  } catch (error) {
    if (error instanceof GhError) return fail(error.message);
    throw error;
  }

  record.lessons.push({ fingerprint: lesson.fingerprint, repo, issue: filed.number, url: filed.url, count: filed.count, refs: lesson.refs, links: lesson.links, to: lesson.to, at: new Date().toISOString() });
  const out = join(checkout, FILED);
  mkdirSync(dirname(out), { recursive: true });
  excludeLocally(checkout, `${dirname(FILED)}/`, relative(checkout, out));
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);

  const lines = [`${filed.action === "opened" ? "Opened" : "Counted on"} ${filed.url} for ${lesson.fingerprint}, seen ${filed.count} time${filed.count === 1 ? "" : "s"}.`];
  if (filed.count >= 3) lines.push(`The class is ready for a PR on ${repo} that carries ${lesson.readyFor}.`);
  if (lesson.links.length > 0) lines.push(`The source PRs stay in ${FILED}:`, ...lesson.links.map((link) => `  ${link}`));
  console.log(lines.join("\n"));
  return 0;
}
