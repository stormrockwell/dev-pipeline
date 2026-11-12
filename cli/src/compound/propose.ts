import { createHash } from "node:crypto";
import { AXES, REVIEWERS } from "../review/findings.ts";
import { GATES } from "../commands/schedule/plan.ts";
import { ZONES } from "../commands/scan-zones/types.ts";
import type { EfficiencyReport } from "../run/efficiency.ts";
import { type Gh, pages } from "./github.ts";
import type { MissedClass, QualityReport } from "./quality.ts";

export const PIPELINE_REPO = "stormrockwell/dev-pipeline";
// The README names this fork as the standards repo in use.
export const STANDARDS_REPO = "stormrockwell/coding-standards";
// A class filed this many times is ready for a PR.
export const READY_AT = 3;
// Long enough for one generic sentence, short enough that it cannot carry a pasted excerpt.
const BECOMES_MAX = 280;
// A run of this many words shared with a reviewer's comment counts as a quote.
const QUOTE_WORDS = 5;

export const LESSONS = {
  mechanical: "Mechanical (a pattern, a banned API, a file location)",
  judgment: "Judgment (consistency, design taste)",
  sensitive: "Missed sensitive code",
  tier: "Wrong tier",
  navigation: "Navigation or missing information",
  "no-effect": "Instruction with no effect",
} as const;

export const FINDINGS = {
  wait: "A stage that waits",
  loop: "A loop that repeats",
  sequence: "A tool sequence that repeats",
  read: "A file every agent reads",
  "false-positive": "A false positive that recurs",
  "cheaper-model": "A role a cheaper model handles in evals",
  "mechanical-model": "An expensive model doing mechanical work",
  flaky: "A flaky test or environment failure",
} as const;

/**
 * A lesson as the public issue carries it, with its evidence kept beside it for the local record
 *
 * `facts` and `title` are built only from fields that cannot hold client content: enums, counts,
 * zone and rule names, pipeline component names and the fingerprint. `becomes` is the one free
 * text, and it passes `privacyProblem` first. `refs`, `links` and `to` never leave the machine.
 */
export interface Lesson {
  half: "quality" | "efficiency";
  fingerprint: string;
  title: string;
  facts: [string, string][];
  evidence: string;
  becomes: string;
  readyFor: string;
  refs: string[];
  links: string[];
  to: string | null;
}

/**
 * What must not reach a public issue, read from the local reports
 */
export interface Denylist {
  words: string[];
  paths: string[];
  identifiers: string[];
  grams: Set<string>;
}

/**
 * The key of a table row named by its key, the start of its label, or the label inside a longer text, or null
 *
 * An analyst often wraps the row in a sentence, so the label that appears first in the text wins.
 */
export function rowKey<T extends Record<string, string>>(table: T, value: string): keyof T | null {
  const wanted = value.trim().toLowerCase();
  if (wanted === "") return null;
  if (wanted in table) return wanted as keyof T;
  const rows = Object.entries(table).map(([key, label]) => [key, label.toLowerCase(), label.toLowerCase().replace(/ \(.*$/, "")] as const);
  const start = rows.find(([, label]) => label.startsWith(wanted));
  if (start) return start[0] as keyof T;
  const inside = rows
    .map(([key, , short]) => [key, wanted.indexOf(short)] as const)
    .filter(([, at]) => at >= 0)
    .sort(([, a], [, b]) => a - b)[0];
  return inside ? (inside[0] as keyof T) : null;
}

/**
 * A stable id for an efficiency class, the same from any repo
 */
export function efficiencyFingerprint(finding: keyof typeof FINDINGS, target: string): string {
  return `e-${createHash("sha256").update(`efficiency|${finding}|${target}`).digest("hex").slice(0, 12)}`;
}

/**
 * The hidden mark an issue carries, so a later filing finds it by its class
 */
export function issueMark(fingerprint: string): string {
  return `<!-- pipeline:lesson ${fingerprint} -->`;
}

/**
 * The hidden mark a repeat comment carries, so the count is read back from the comments
 */
export function repeatMark(fingerprint: string): string {
  return `<!-- pipeline:lesson-seen ${fingerprint} -->`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const words = (text: string) => text.toLowerCase().match(/[a-z0-9_$']+/g) ?? [];
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a text holds a word or name as a whole token
 */
function holds(text: string, token: string): boolean {
  return new RegExp(`(^|[^\\w-])${escape(token)}($|[^\\w-])`, "i").test(text);
}

/**
 * Every run of `QUOTE_WORDS` words in a text
 */
function grams(text: string): string[] {
  const list = words(text);
  return list.slice(0, Math.max(0, list.length - QUOTE_WORDS + 1)).map((_, index) => list.slice(index, index + QUOTE_WORDS).join(" "));
}

/**
 * The client names, paths, identifiers and comment text the local reports hold
 *
 * `open` lists repos whose names are public anyway, the pipeline and standards repos, so filing
 * from inside them still works.
 */
export function denylist(quality: QualityReport | null, efficiency: EfficiencyReport | null, repos: string[], open: string[]): Denylist {
  const names = new Set<string>(repos);
  const paths = new Set<string>();
  const identifiers = new Set<string>();
  const gramSet = new Set<string>();
  for (const source of quality?.sources.repos ?? []) names.add(source.repo);
  for (const entry of quality?.classes ?? []) {
    for (const ref of entry.refs ?? []) names.add(ref.split("#")[0]!);
    for (const example of entry.examples) {
      names.add(example.repo);
      if (example.path !== null) paths.add(example.path);
      for (const gram of grams(example.text)) gramSet.add(gram);
      for (const token of example.text.match(/[$\w]*(?:_|\$|->|::)[$\w>:]*|\b[a-z]+[A-Z]\w*/g) ?? []) if (token.replace(/[^A-Za-z0-9]/g, "").length >= 3) identifiers.add(token);
    }
  }
  // The pipeline lays out its own files under .pipeline/, so their names say nothing about a client.
  const project = (path: string) => !path.startsWith(".pipeline/");
  for (const read of efficiency?.reads ?? []) if (project(read.path)) paths.add(read.path);
  for (const sequence of efficiency?.sequences ?? []) {
    for (const step of sequence.steps) {
      const path = step.split(" ").slice(1).join(" ");
      if (/^(Read|Write|Edit|NotebookEdit) /.test(step) && project(path)) paths.add(path);
    }
  }
  const publicWords = new Set(open.flatMap((repo) => repo.toLowerCase().split("/")));
  const wordSet = new Set<string>();
  for (const name of names) {
    for (const part of name.toLowerCase().split("/")) if (part.length >= 3 && !publicWords.has(part)) wordSet.add(part);
  }
  // A segment or file stem built from several words, such as class-acme-sync, names a client's code as surely as its path, while a plain word such as settings names nothing.
  const coined = (name: string) => name.length >= 4 && /[-_\d]|[a-z][A-Z]/.test(name);
  const pathSet = new Set<string>();
  for (const path of paths) {
    pathSet.add(path);
    for (const part of path.split("/")) {
      const stem = part.replace(/\.[^.]+$/, "");
      if (coined(part) || (part !== stem && part.length >= 4)) pathSet.add(part);
      if (coined(stem)) pathSet.add(stem);
    }
  }
  return { words: [...wordSet].sort(), paths: [...pathSet].sort(), identifiers: [...identifiers].sort(), grams: gramSet };
}

/**
 * Why a text would leak something the denylist holds, or null when it is clean
 */
export function leak(text: string, deny: Denylist): string | null {
  const name = deny.words.find((word) => holds(text, word));
  if (name) return `it names "${name}", which is part of a repo's name in the local reports`;
  const path = deny.paths.find((entry) => holds(text, entry));
  if (path) return `it names "${path}", which is a path from the local reports`;
  const identifier = deny.identifiers.find((entry) => text.includes(entry));
  if (identifier) return `it holds "${identifier}", which is code from a review comment`;
  const quote = grams(text).find((gram) => deny.grams.has(gram));
  if (quote) return `it quotes "${quote}" from a review comment`;
  return null;
}

// Names a file in the pipeline or a project's pipeline config, which are public by design.
const PIPELINE_FILES = new Set(["sensitive.yml", "profile.yml", "hooks.json", "SKILL.md", "CLAUDE.md", "AGENTS.md", "phpcs.xml", "phpcs.xml.dist", "eslint.config.js", "eslint.config.mjs", "semgrep.yml"]);
const PIPELINE_ROOTS = /^(plugin|cli|docs|templates|tools|\.pipeline)[/]/;
// Product names that look like file names.
const PRODUCTS = new Set(["node.js", "next.js", "vue.js", "react.js", "nuxt.js", "express.js"]);

/**
 * Why a free text may not go into a public issue, or null when it may
 *
 * It must be one plain sentence: no link, mention, PR number, repo slug, client path, code or
 * quote from the reports.
 */
export function privacyProblem(text: string, deny: Denylist): string | null {
  if (text.trim() === "") return "is empty";
  if (text.length > BECOMES_MAX) return `is longer than ${BECOMES_MAX} characters`;
  if (/[\r\n]/.test(text)) return "spans more than one line";
  if (/https?:[/][/]|www\./i.test(text)) return "holds a link";
  if (/(^|\s)@[\w-]/.test(text)) return "mentions someone";
  if (/[\w.-]+@[\w-]+\.\w/.test(text)) return "holds an email address";
  if (/#\d+/.test(text)) return "names a PR or issue number";
  if (/[`$;{}<>=]|->|::|\w\(/.test(text)) return "holds code, so say what it does in words";
  for (const token of text.split(/[\s,()"']+/)) {
    const bare = token.replace(/[.:!?]+$/, "");
    if (bare.includes("/") && !PIPELINE_ROOTS.test(bare)) return `names "${bare}", which looks like a repo or a path outside the pipeline`;
    if (/[\w-]{2,}\.[a-z0-9]{1,5}$/i.test(bare) && !bare.includes("/") && !PIPELINE_FILES.has(bare) && !PRODUCTS.has(bare.toLowerCase())) return `names "${bare}", which looks like a file outside the pipeline`;
  }
  const leaked = leak(text, deny);
  return leaked === null ? null : leaked.replace(/^it /, "");
}

/**
 * Why a target is not a part of the pipeline, or null when it is
 *
 * `components` lists the plugin's skills and agents as `dev-pipeline:<name>`, and the CLI's
 * commands as `pipeline <command>`. A copy of the CLI without its plugin passes no plugin names,
 * so any `dev-pipeline:<name>` shaped name stands.
 */
export function targetProblem(target: string, components: { plugin: string[] | null; commands: string[] }): string | null {
  if (target === "hooks") return null;
  const plugin = /^dev-pipeline:([a-z][a-z-]*)$/.exec(target);
  if (plugin) return components.plugin === null || components.plugin.includes(target) ? null : `${target} is no skill or agent of the plugin`;
  const command = /^pipeline ([a-z][a-z-]*)$/.exec(target);
  if (command) return components.commands.includes(command[1]!) ? null : `${target} is no pipeline command`;
  return `--target takes dev-pipeline:<skill or agent>, pipeline <command> or hooks, not "${target}"`;
}

/**
 * Whether an area is one the pipeline itself names: a built-in zone or a review rule doc
 */
function publicArea(area: string): boolean {
  if (area.startsWith("zone:")) return (ZONES as readonly string[]).includes(area.slice(5));
  return /^rules:[a-z_]+$/.test(area);
}

// The hint texts quality.ts writes, so nothing else in a tampered report reaches an issue.
const HINT = /^(?:zone not in the plan|planned below T3|skipped (.+) before the fix) on \d+ PRs?$/;
// A skip hint names a gate from a PR's record, which a work order can word freely, so only the pipeline's own gates pass.
const KNOWN_GATES = new Set<string>([...Object.values(GATES).flat(), ...REVIEWERS]);

/**
 * Whether a hint is one quality.ts writes, naming only a gate the pipeline plans
 */
function publicHint(hint: string): boolean {
  const match = HINT.exec(hint);
  return match !== null && (match[1] === undefined || KNOWN_GATES.has(match[1]));
}

/**
 * A pipeline lesson from a missed class in the quality report, or why it cannot be filed
 */
export function qualityLesson(report: QualityReport, fingerprint: string, lesson: keyof typeof LESSONS, becomes: string, deny: Denylist): Lesson | string {
  const entry: MissedClass | undefined = report.classes.find((item) => item.fingerprint === fingerprint);
  if (!entry) return `no class ${fingerprint} in the quality report`;
  if (!(AXES as readonly string[]).includes(entry.axis) || !(REVIEWERS as readonly string[]).includes(entry.owner)) return `class ${fingerprint} has an axis or owner the pipeline does not know`;
  if (!publicArea(entry.area)) return `class ${fingerprint} sits in ${entry.area}, which the pipeline does not name`;
  const problem = privacyProblem(becomes, deny);
  if (problem) return `--becomes ${problem}`;
  const signals = Object.entries(entry.signals)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => plural(count, kind === "human" ? "human comment" : kind));
  const evidence = `${plural(entry.prs, "PR")} in ${plural(entry.repos, "repo")}${signals.length > 0 ? `, ${signals.join(", ")}` : ""}`;
  const hints = entry.hints.filter((hint) => publicHint(hint) && leak(hint, deny) === null);
  const refs = entry.refs ?? [];
  return {
    half: "quality",
    fingerprint,
    title: `Missed ${entry.axis} in ${entry.area} (${fingerprint})`,
    facts: [
      ["Axis", entry.axis],
      ["Area", entry.area],
      ["Owner", `the ${entry.owner} reviewer`],
      ["Lesson", LESSONS[lesson]],
      ["Evidence", evidence],
      ...(hints.length > 0 ? [["Hints", hints.join(", ")] as [string, string]] : []),
    ],
    evidence,
    becomes: becomes.trim(),
    readyFor: "a synthetic eval case that fails before the change and passes after, with no regression in the full suite",
    refs,
    links: refs.map((ref) => {
      const [repo, number] = ref.split("#");
      return `https://github.com/${repo}/pull/${number}`;
    }),
    to: null,
  };
}

/**
 * A pipeline lesson from an efficiency finding the analyst named, or why it cannot be filed
 */
export function efficiencyLesson(report: EfficiencyReport, finding: keyof typeof FINDINGS, target: string, becomes: string, deny: Denylist): Lesson | string {
  const problem = privacyProblem(becomes, deny);
  if (problem) return `--becomes ${problem}`;
  const fingerprint = efficiencyFingerprint(finding, target);
  const evidence = `${plural(report.sources.sessions, "session")}, ${plural(report.sources.streams, "stream")}, ${plural(report.sources.calls, "tool call")}`;
  return {
    half: "efficiency",
    fingerprint,
    title: `${FINDINGS[finding]} in ${target} (${fingerprint})`,
    facts: [
      ["Finding", FINDINGS[finding]],
      ["Target", target],
      ["Evidence", evidence],
    ],
    evidence,
    becomes: becomes.trim(),
    readyFor: "a before and after measurement on the same eval cases, where tokens, turns or time fall and recall and precision hold",
    refs: [],
    links: [],
    to: report.sources.to,
  };
}

/**
 * The issue's body, from the lesson's public fields only
 */
export function issueBody(lesson: Lesson, version: string | null, closed: number | null): string {
  const rows = [...lesson.facts, ...(version === null ? [] : [["Pipeline", version] as [string, string]])];
  return [
    issueMark(lesson.fingerprint),
    `The compounder's ${lesson.half} half found a class the pipeline let through.`,
    "",
    "| | |",
    "|---|---|",
    ...rows.map(([key, value]) => `| ${key} | ${value} |`),
    "",
    `Becomes: ${lesson.becomes}`,
    "",
    `Seen 1 time. A repeat from any repo or developer raises the count in a comment, and at ${READY_AT} the class is ready for a PR that carries ${lesson.readyFor}.`,
    ...(closed === null ? [] : ["", `An earlier issue for this class, #${closed}, was closed.`]),
    "",
    "Filed by `pipeline compound file`. The source PRs stay in the filer's local compounder report.",
  ].join("\n");
}

/**
 * The comment that raises the count on an open issue
 */
export function repeatBody(lesson: Lesson, count: number): string {
  const ready = count >= READY_AT ? `, so this class is ready for a PR that carries ${lesson.readyFor}` : "";
  return [repeatMark(lesson.fingerprint), `Seen again, on ${lesson.evidence}. Becomes: ${lesson.becomes}`, "", `Count: ${count}${ready}.`].join("\n");
}

interface Issue {
  number: number;
  state: string;
  body: string | null;
  html_url: string;
}

/**
 * Reading and writing GitHub, so tests can stand in for gh
 */
export interface IssueApi {
  get: Gh;
  post: (path: string, body: unknown) => Promise<unknown>;
}

/**
 * The open issue that carries a class, or the latest closed one
 *
 * A known number from the local record is read first, because a new issue takes a while to reach search.
 */
export async function findIssue(api: IssueApi, repo: string, fingerprint: string, known: number | null): Promise<{ open: Issue | null; closed: Issue | null }> {
  const marked = (issue: Issue) => (issue.body ?? "").includes(issueMark(fingerprint));
  if (known !== null) {
    const issue = (await api.get(`repos/${repo}/issues/${known}`)) as Issue;
    if (issue.state === "open" && marked(issue)) return { open: issue, closed: null };
  }
  const query = `repo:${repo} is:issue in:title "${fingerprint}"`;
  const found = ((await api.get(`search/issues?q=${encodeURIComponent(query)}&per_page=100`)) as { items?: Issue[] }).items ?? [];
  const mine = found.filter(marked).sort((a, b) => b.number - a.number);
  return { open: mine.find((issue) => issue.state === "open") ?? null, closed: mine.find((issue) => issue.state !== "open") ?? null };
}

/**
 * How many times an issue's class has been seen: the issue itself and each repeat comment
 */
export async function countOf(api: IssueApi, repo: string, issue: number, fingerprint: string): Promise<number> {
  const comments = await pages<{ body: string | null }>(api.get, `repos/${repo}/issues/${issue}/comments`);
  return 1 + comments.filter((comment) => (comment.body ?? "").includes(repeatMark(fingerprint))).length;
}

/**
 * What filing did
 */
export interface Filed {
  action: "opened" | "counted";
  number: number;
  url: string;
  count: number;
}

/**
 * Raises the count on the open issue for a lesson's class, or opens one
 */
export async function fileLesson(api: IssueApi, repo: string, lesson: Lesson, version: string | null, known: number | null): Promise<Filed> {
  const { open, closed } = await findIssue(api, repo, lesson.fingerprint, known);
  if (open) {
    const count = (await countOf(api, repo, open.number, lesson.fingerprint)) + 1;
    await api.post(`repos/${repo}/issues/${open.number}/comments`, { body: repeatBody(lesson, count) });
    return { action: "counted", number: open.number, url: open.html_url, count };
  }
  const created = (await api.post(`repos/${repo}/issues`, { title: lesson.title, body: issueBody(lesson, version, closed?.number ?? null) })) as Issue;
  return { action: "opened", number: created.number, url: created.html_url, count: 1 };
}
