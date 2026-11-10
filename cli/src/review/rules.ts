import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { matchesGlob } from "../commands/scan-zones/glob.ts";
import { gitOut, lines } from "../task/git.ts";

// The OCR release the adapter is written against. Its delegate JSON is schema version 1.
export const OCR_VERSION = "1.13.3";
export const OCR_PACKAGE = "@alibaba-group/open-code-review";

const rulesDir = new URL("./rules/", import.meta.url);

/**
 * The files to review and the rules for each, as the standards reviewer reads them
 */
export interface FileRules {
  source: string;
  files: { path: string; status: string }[];
  excluded: { path: string; reason: string }[];
  groups: { files: string[]; rule: string }[];
  note: string | null;
}

// The subset of OCR's system_rules.json path map that the vendored docs cover, first match wins.
const VENDORED: [string, string][] = [
  ["**/package.json", "package_json.md"],
  ["**/composer.json", "composer_json.md"],
  ["**/*.{json,json5}", "json.md"],
  [".github/workflows/**/*.{yaml,yml}", "github_workflows.md"],
  ["**/*.{yaml,yml}", "yaml.md"],
  ["**/*.{ts,js,tsx,jsx,mjs,cjs}", "ts_js_tsx_jsx.md"],
  ["**/*.{php,phtml}", "php.md"],
];

// Files a review never reads, as OCR's default excludes treat them.
const EXCLUDED: [RegExp, string][] = [
  [/(?:^|\/)(?:package-lock\.json|composer\.lock|yarn\.lock|pnpm-lock\.yaml)$/, "lock file"],
  [/(?:^|\/)(?:vendor|node_modules|dist|build)\//, "vendored or built output"],
  [/\.min\.(?:js|css)$/, "minified"],
  [/\.(?:png|jpe?g|gif|webp|ico|svg|pdf|zip|woff2?|ttf|eot|mp4|mov)$/i, "binary or media"],
];

/**
 * Expands brace choices in a glob into one glob per choice
 */
function expand(glob: string): string[] {
  const match = /\{([^}]+)\}/.exec(glob);
  if (!match) return [glob];
  return match[1]!.split(",").flatMap((choice) => expand(glob.replace(match[0], choice)));
}

/**
 * The vendored rule doc for a path, or OCR's default doc
 */
export function vendoredRule(path: string): string {
  const hit = VENDORED.find(([glob]) => expand(glob).some((choice) => matchesGlob(choice, path)));
  return hit ? hit[1] : "default.md";
}

/**
 * Reads a vendored rule doc
 */
function readRule(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, rulesDir)), "utf8");
}

/**
 * The ocr command to run, PIPELINE_OCR first
 */
function ocrCommand(): string {
  return process.env.PIPELINE_OCR?.trim() || "ocr";
}

/**
 * Runs the OCR CLI in the worktree with telemetry off, or returns null when it is missing or fails
 */
function ocr(worktree: string, args: string[]): unknown | null {
  const result = spawnSync(ocrCommand(), args, { cwd: worktree, encoding: "utf8", timeout: 120_000, env: { ...process.env, OCR_ENABLE_TELEMETRY: "0" }, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

interface Preview {
  schema_version?: string;
  reviewable_files?: { path: string; status: string }[];
  excluded_files?: { path: string; exclude_reason?: string }[];
}

interface Rules {
  groups?: { files: string[]; rule: string }[];
}

/**
 * The files and rules from OCR's delegation mode, mapped into the pipeline's shape
 */
function fromOcr(worktree: string, from: string): FileRules | null {
  const preview = ocr(worktree, ["delegate", "preview", "--format", "json", "--from", from, "--to", "HEAD"]) as Preview | null;
  if (preview === null || preview.schema_version !== "1" || !Array.isArray(preview.reviewable_files)) return null;
  const files = preview.reviewable_files.map((file) => ({ path: file.path, status: file.status }));
  const excluded = (preview.excluded_files ?? []).map((file) => ({ path: file.path, reason: file.exclude_reason ?? "excluded" }));
  if (files.length === 0) return { source: `ocr ${OCR_VERSION} delegation`, files, excluded, groups: [], note: null };
  const rules = ocr(worktree, ["delegate", "rule", "--format", "json", ...files.map((file) => file.path)]) as Rules | null;
  if (rules === null || !Array.isArray(rules.groups)) return null;
  return { source: `ocr ${OCR_VERSION} delegation`, files, excluded, groups: rules.groups.map((group) => ({ files: group.files, rule: group.rule })), note: null };
}

/**
 * The files and rules from the vendored docs, for when OCR is not installed
 */
function fromVendored(worktree: string, from: string): FileRules {
  const files: FileRules["files"] = [];
  const excluded: FileRules["excluded"] = [];
  for (const line of lines(gitOut(worktree, ["diff", "--name-status", "--no-renames", from, "HEAD"]))) {
    const [status, path] = line.split("\t") as [string, string];
    if (status.startsWith("D")) {
      excluded.push({ path, reason: "deleted" });
      continue;
    }
    const skip = EXCLUDED.find(([pattern]) => pattern.test(path));
    if (skip) excluded.push({ path, reason: skip[1] });
    else files.push({ path, status: status === "A" ? "added" : "modified" });
  }
  const byRule = new Map<string, string[]>();
  for (const file of files) {
    const rule = vendoredRule(file.path);
    byRule.set(rule, [...(byRule.get(rule) ?? []), file.path]);
  }
  return {
    source: `vendored OCR ${OCR_VERSION} rules`,
    files,
    excluded,
    groups: [...byRule].map(([rule, paths]) => ({ files: paths, rule: readRule(rule) })),
    note: `ocr was not found, so these are the vendored rules. Install the pinned CLI with \`npm install -g ${OCR_PACKAGE}@${OCR_VERSION}\` for OCR's own file selection.`,
  };
}

/**
 * Selects the files to review and resolves their rules, through OCR when it runs and the vendored rules otherwise
 */
export function fileRules(worktree: string, from: string): FileRules {
  return fromOcr(worktree, from) ?? fromVendored(worktree, from);
}

/**
 * The file rules as Markdown for the reviewer
 */
export function renderFileRules(rules: FileRules): string {
  const out = [`Files and rules from ${rules.source}.`, ""];
  if (rules.note) out.push(rules.note, "");
  out.push("## Files to review", "", ...rules.files.map((file) => `- ${file.path} (${file.status})`), "");
  if (rules.excluded.length > 0) out.push("## Excluded", "", ...rules.excluded.map((file) => `- ${file.path}: ${file.reason}`), "");
  rules.groups.forEach((group, index) => {
    out.push(`## Rule group ${index + 1}: ${group.files.join(", ")}`, "", group.rule.trim(), "");
  });
  return out.join("\n");
}
