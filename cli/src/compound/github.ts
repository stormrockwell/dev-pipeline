import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseHiddenComment, type GateRecord } from "../commands/gate-record/record.ts";
import { scanFile } from "../commands/scan-zones/scan.ts";
import type { RemovedLine, ZoneConfig } from "../commands/scan-zones/types.ts";

export const CACHE_DIR = ".pipeline/compound/github";
const CACHE_VERSION = 2;
const PAGE = 100;
// GitHub serves at most 3000 files of a PR, which is 30 pages.
const MAX_PAGES = 30;
const CONCURRENCY = 6;
// Long enough for a reviewer's point, short enough that the saved fetch holds no more of the code than that.
const EXCERPT = 300;

/**
 * A file a PR or commit touched, with the zones its path and patch fall in
 */
export interface Touch {
  path: string;
  zones: string[];
}

/**
 * A comment on a merged PR
 *
 * A human comment comes from a reviewer other than the author. An agent comment comes from a bot
 * account or carries the pipeline's own marks. The author's replies count as neither. Only a human
 * comment keeps its text, cut to an excerpt.
 */
export interface Comment {
  author: string;
  kind: "human" | "agent" | "author";
  body: string | null;
  path: string | null;
  zones: string[];
  at: string;
}

/**
 * The parts of a PR's gate record the quality half reads
 */
export interface RecordSummary {
  version: number;
  pipeline: string | null;
  tiers: string[];
  zones: string[];
  // Gates that did not pass, with the reason a skip gave or "not run" for a gate nobody recorded.
  skipped: { gate: string; reason: string }[];
  findings: { opened: number; fixed: number; accepted: number };
}

/**
 * An approval a reviewer other than the author gave a PR
 */
export interface Approval {
  by: string;
  at: string;
}

export interface MergedPr {
  number: number;
  title: string;
  author: string;
  opened: string | null;
  mergedAt: string;
  mergeSha: string | null;
  base: string;
  files: Touch[];
  comments: Comment[];
  approvals: Approval[];
  record: RecordSummary | null;
  // The whole record, for the metrics page, which reads the fields the summary leaves out.
  gate: GateRecord | null;
}

/**
 * A `fix:` or revert commit on a branch the PRs merged into
 */
export interface BranchCommit {
  sha: string;
  subject: string;
  message: string;
  at: string;
  files: Touch[];
}

/**
 * Everything the quality half read from one repo, as the local cache keeps it
 */
export interface RepoData {
  version: typeof CACHE_VERSION;
  repo: string;
  fetchedAt: string;
  since: string;
  prs: MergedPr[];
  commits: BranchCommit[];
}

export class GhError extends Error {}

export type Gh = (path: string) => Promise<unknown>;

/**
 * Calls `gh api` with one path and parses its JSON
 */
export const gh: Gh = (path) =>
  new Promise((resolve, reject) => {
    execFile("gh", ["api", path], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(new GhError("gh is not installed, and the quality half reads GitHub through it."));
      if (error) return reject(new GhError(`gh api ${path} failed: ${(stderr || stdout || error.message).trim()}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new GhError(`gh api ${path} printed no JSON.`));
      }
    });
  });

/**
 * Runs a task per item, a few at a time, keeping the items' order
 */
async function pool<T, R>(items: T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

/**
 * Every item of a listing, page by page, until a short page or `stop` says the rest is too old
 */
async function pages<T>(call: Gh, path: string, stop: (page: T[]) => boolean = () => false): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const items = (await call(`${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE}&page=${page}`)) as T[];
    if (!Array.isArray(items)) throw new GhError(`gh api ${path} gave no list.`);
    all.push(...items);
    if (items.length < PAGE || stop(items)) break;
  }
  return all;
}

/**
 * The scan input of one file's patch: the new side's lines with their numbers, and the removed lines
 *
 * GitHub sends hunks with context lines, which stay in the content so a signal's `near` rule sees them.
 */
function patchInput(path: string, patch: string | null) {
  if (patch === null) return { path, content: null, added: null, removed: [] as RemovedLine[], deleted: false };
  const lines: string[] = [];
  const added = new Set<number>();
  const removed: RemovedLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (line.startsWith("-")) {
      removed.push({ line: oldLine++, text: line.slice(1) });
      continue;
    }
    if (line.startsWith("+")) added.add(newLine);
    else oldLine += 1;
    if (newLine > 0) lines[newLine - 1] = line.slice(1);
    newLine += 1;
  }
  return { path, content: Array.from(lines, (line) => line ?? "").join("\n"), added, removed, deleted: false };
}

/**
 * The zones a file's path and patch fall in
 */
export function zonesOf(config: ZoneConfig, path: string, patch: string | null): string[] {
  return scanFile(config, patchInput(path, patch)).zones;
}

/**
 * The zones of the code a review comment sits on, from its path and the hunk GitHub quotes
 *
 * The whole hunk counts, because the comment is about the lines around it.
 */
function hunkZones(config: ZoneConfig, path: string, hunk: string | null): string[] {
  if (hunk === null) return zonesOf(config, path, null);
  const content = hunk
    .split("\n")
    .filter((line) => !line.startsWith("@@") && !line.startsWith("-"))
    .map((line) => line.slice(1))
    .join("\n");
  return scanFile(config, { path, content, added: null, removed: [], deleted: false }).zones;
}

// The pipeline's own marks, and the ones Claude Code leaves, on a comment an agent wrote under a person's account.
const AGENT_MARKS = /Co-Authored using AI|Generated with \[?Claude|🤖|<!-- pipeline:|^\s*(Route|Status):/im;
// A comment that only approves names nothing a reviewer caught.
const NOTHING_CAUGHT = /^\s*(lgtm|looks good( to me)?|approved?|ship it|thanks?( you)?|nice|great|\+1|👍|:shipit:)?[\s.!]*$/i;

interface User {
  login?: string;
  type?: string;
}

/**
 * Whether a comment came from a person reviewing, an agent, or the PR's author
 */
export function commentKind(user: User | null, body: string, author: string): Comment["kind"] {
  const login = user?.login ?? "";
  if (user?.type === "Bot" || login.endsWith("[bot]") || AGENT_MARKS.test(body)) return "agent";
  return login === author ? "author" : "human";
}

/**
 * Cuts a comment to an excerpt on one line
 */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat;
}

/**
 * The parts of a gate record the quality half reads, from a record of any version
 */
export function summarizeRecord(record: GateRecord): RecordSummary {
  const tasks = Array.isArray(record.tasks) ? record.tasks : [];
  const gates = Array.isArray(record.gates) ? record.gates : [];
  return {
    version: record.version,
    pipeline: record.pipeline ?? null,
    tiers: [...new Set(tasks.map((task) => task.tier))].sort(),
    zones: [...new Set(tasks.flatMap((task) => task.zones ?? []))].sort(),
    skipped: gates.filter((gate) => gate.result === "skip" || gate.result === "pending").map((gate) => ({ gate: gate.gate, reason: gate.result === "skip" ? (gate.note ?? "skipped") : "not run" })),
    findings: { opened: record.findings?.opened ?? 0, fixed: record.findings?.fixed ?? 0, accepted: record.findings?.accepted ?? 0 },
  };
}

interface ApiPr {
  number: number;
  title: string;
  user: User | null;
  created_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  updated_at: string;
  base: { ref: string };
  body: string | null;
}

interface ApiComment {
  user: User | null;
  state?: string;
  body: string | null;
  path?: string;
  diff_hunk?: string;
  created_at?: string;
  submitted_at?: string;
}

interface ApiCommit {
  sha: string;
  commit: { message: string; committer: { date: string } | null; author: { date: string } | null };
}

const FIX = /^fix(\([^)]*\))?!?:/i;
const REVERT = /^(revert(\([^)]*\))?!?:|Revert ")/i;

/**
 * One merged PR's files, comments and record
 */
async function readPr(call: Gh, repo: string, pr: ApiPr, config: ZoneConfig): Promise<MergedPr> {
  const author = pr.user?.login ?? "";
  const base = `repos/${repo}`;
  const [files, inline, reviews, conversation] = await Promise.all([
    pages<{ filename: string; patch?: string }>(call, `${base}/pulls/${pr.number}/files`),
    pages<ApiComment>(call, `${base}/pulls/${pr.number}/comments`),
    pages<ApiComment>(call, `${base}/pulls/${pr.number}/reviews`),
    pages<ApiComment>(call, `${base}/issues/${pr.number}/comments`),
  ]);
  const comments: Comment[] = [];
  for (const comment of [...inline, ...reviews, ...conversation]) {
    const body = comment.body ?? "";
    if (NOTHING_CAUGHT.test(body)) continue;
    const kind = commentKind(comment.user, body, author);
    const path = comment.path ?? null;
    comments.push({
      author: comment.user?.login ?? "",
      kind,
      body: kind === "human" ? excerpt(body) : null,
      path,
      zones: kind === "human" && path !== null ? hunkZones(config, path, comment.diff_hunk ?? null) : [],
      at: comment.created_at ?? comment.submitted_at ?? pr.merged_at!,
    });
  }
  const approvals: Approval[] = reviews
    .filter((review) => review.state === "APPROVED" && review.user?.type !== "Bot" && !(review.user?.login ?? "").endsWith("[bot]") && review.user?.login !== author)
    .map((review) => ({ by: review.user?.login ?? "", at: review.submitted_at ?? pr.merged_at! }));
  const record = parseHiddenComment(pr.body ?? "");
  return {
    number: pr.number,
    title: pr.title,
    author,
    opened: pr.created_at ?? null,
    mergedAt: pr.merged_at!,
    mergeSha: pr.merge_commit_sha,
    base: pr.base.ref,
    files: files.map((file) => ({ path: file.filename, zones: zonesOf(config, file.filename, file.patch ?? null) })),
    comments,
    approvals,
    record: record ? summarizeRecord(record) : null,
    gate: record,
  };
}

/**
 * Reads a repo's PRs merged since a time, and the `fix:` and revert commits that landed after the first of them
 *
 * PRs come newest update first, so the listing stops at the first page whose last PR was updated
 * before `since`, since a PR merged later was updated later too.
 */
export async function fetchRepo(call: Gh, repo: string, since: Date, config: ZoneConfig): Promise<RepoData> {
  const from = since.toISOString();
  const listed = await pages<ApiPr>(call, `repos/${repo}/pulls?state=closed&sort=updated&direction=desc`, (page) => page.at(-1)!.updated_at < from);
  const merged = listed.filter((pr) => pr.merged_at !== null && pr.merged_at >= from).sort((a, b) => a.merged_at!.localeCompare(b.merged_at!));
  const prs = await pool(merged, (pr) => readPr(call, repo, pr, config));

  const commits: BranchCommit[] = [];
  if (prs.length > 0) {
    const seen = new Set<string>();
    for (const branch of [...new Set(prs.map((pr) => pr.base))].sort()) {
      let listing: ApiCommit[];
      try {
        listing = await pages<ApiCommit>(call, `repos/${repo}/commits?sha=${encodeURIComponent(branch)}&since=${prs[0]!.mergedAt}`);
      } catch (error) {
        // A deleted base branch is gone from the API, and the commits it held live on in the branch it merged into.
        if (error instanceof GhError && /HTTP 404/.test(error.message)) continue;
        throw error;
      }
      const wanted = listing.filter((commit) => !seen.has(commit.sha) && (FIX.test(commit.commit.message) || REVERT.test(commit.commit.message)));
      for (const commit of wanted) seen.add(commit.sha);
      commits.push(
        ...(await pool(wanted, async (commit) => {
          const full = (await call(`repos/${repo}/commits/${commit.sha}`)) as { files?: { filename: string; patch?: string }[] };
          return {
            sha: commit.sha,
            subject: commit.commit.message.split("\n")[0]!,
            message: commit.commit.message.slice(0, 2000),
            at: commit.commit.committer?.date ?? commit.commit.author?.date ?? "",
            files: (full.files ?? []).map((file) => ({ path: file.filename, zones: zonesOf(config, file.filename, file.patch ?? null) })),
          };
        })),
      );
    }
  }
  commits.sort((a, b) => a.at.localeCompare(b.at));
  return { version: CACHE_VERSION, repo, fetchedAt: new Date().toISOString(), since: from, prs, commits };
}

/**
 * Where a repo's last fetch is kept
 */
export function cachePath(checkout: string, repo: string): string {
  return join(checkout, CACHE_DIR, `${repo.replace("/", "__")}.json`);
}

/**
 * Keeps a fetch, so a rerun can read it with --offline
 */
export function writeCache(checkout: string, data: RepoData): string {
  const path = cachePath(checkout, data.repo);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data)}\n`);
  return path;
}

/**
 * A repo's last fetch, or null when there is none of this cache version
 */
export function readCache(checkout: string, repo: string): RepoData | null {
  const path = cachePath(checkout, repo);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as RepoData;
    return data.version === CACHE_VERSION && data.repo === repo ? data : null;
  } catch {
    return null;
  }
}

/**
 * The owner and name of a GitHub remote URL, or null for another host
 */
export function repoOfRemote(url: string): string | null {
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? match[1]! : null;
}
