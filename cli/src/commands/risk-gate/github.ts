import { spawnSync } from "node:child_process";
import type { Review } from "./reviews.ts";

export interface PullRequestEvent {
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  headSha: string;
  labels: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// Reads the fields the gate needs from a `pull_request` or `pull_request_review` event payload.
export function parseEvent(payload: unknown): PullRequestEvent {
  const root = record(payload);
  const pr = record(root?.pull_request);
  const user = record(pr?.user);
  const head = record(pr?.head);
  const repository = record(root?.repository);
  const repo = repository?.full_name;
  if (!root || !pr || typeof pr.number !== "number" || typeof user?.login !== "string" || typeof head?.sha !== "string" || typeof repo !== "string") {
    throw new Error("the event payload is not a pull request event. Pass the file that GITHUB_EVENT_PATH names.");
  }
  const labels = Array.isArray(pr.labels) ? pr.labels.map((label) => record(label)?.name).filter((name): name is string => typeof name === "string") : [];
  return {
    repo,
    number: pr.number,
    title: typeof pr.title === "string" ? pr.title : "",
    body: typeof pr.body === "string" ? pr.body : "",
    author: user.login,
    headSha: head.sha,
    labels,
  };
}

// Reads reviews as a JSON array, or as one JSON object per line, which is what `gh api --jq '.[]'` prints.
export function parseReviews(text: string): Review[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const parsed: unknown = trimmed.startsWith("[") ? JSON.parse(trimmed) : trimmed.split("\n").map((line) => JSON.parse(line));
  if (!Array.isArray(parsed)) throw new Error("reviews must be a JSON array.");
  return parsed as Review[];
}

// Reviews are not in the event payload, so the workflow reads them with its own token.
export function fetchReviews(repo: string, number: number): Review[] {
  const result = spawnSync("gh", ["api", "--paginate", `repos/${repo}/pulls/${number}/reviews`, "--jq", ".[]"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`could not read the reviews of ${repo}#${number}: ${(result.stderr || String(result.error ?? "")).trim()}`);
  return parseReviews(result.stdout);
}

// Arguments for `gh pr edit`, or null when the labels already match.
export function labelEditArgs(repo: string, number: number, labels: { add: string[]; remove: string[] }): string[] | null {
  if (labels.add.length === 0 && labels.remove.length === 0) return null;
  const args = ["pr", "edit", String(number), "--repo", repo];
  if (labels.add.length > 0) args.push("--add-label", labels.add.join(","));
  if (labels.remove.length > 0) args.push("--remove-label", labels.remove.join(","));
  return args;
}

export function applyLabels(repo: string, number: number, labels: { add: string[]; remove: string[] }): { ok: boolean; error?: string } {
  const args = labelEditArgs(repo, number, labels);
  if (!args) return { ok: true };
  const result = spawnSync("gh", args, { encoding: "utf8" });
  return result.status === 0 ? { ok: true } : { ok: false, error: (result.stderr || String(result.error ?? "")).trim() };
}
