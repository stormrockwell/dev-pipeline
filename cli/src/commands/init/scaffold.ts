import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlannedFile } from "./files.ts";
import { packsFor, renderProfile, renderSensitive, type Facts } from "./profile.ts";
import type { Answers } from "./questions.ts";

const templates = fileURLToPath(new URL("../../../../templates/", import.meta.url));

/**
 * The standards fork commit that holds the base and WordPress layers. The v1.0.0 tag predates the split, so
 * projects pin a commit until the fork cuts the next tag.
 */
export const STANDARDS_REF = "f48a9e1333edbe6a98377ab6f51f09d4d531e0d7";

const DEFAULT_NODE = "24";
// New WordPress plugins start at PHP 8.0, as the strategy sets for every plugin the pipeline creates.
const PLUGIN_PHP = "8.0";

// Template names that carry a project token, because a filename with braces is awkward on disk.
const RENAMES: Record<string, string> = {
  "plugin-main.php": "{{slug}}.php",
  "includes/class-greeting.php": "includes/class-{{slug}}-greeting.php",
};

export type ScaffoldType = "node-site" | "wordpress-plugin";

export interface Scaffold {
  files: PlannedFile[];
  facts: Facts;
  notes: string[];
}

function pascal(slug: string): string {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("_");
}

function tokensFor(answers: Answers, fallbackName: string): Record<string, string> {
  const name = answers.name ?? fallbackName;
  // The name lands inside JSON, PHP and TypeScript strings, so it stays free of quotes and escapes.
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) {
    throw new Error(`name "${name}" may hold only letters, digits, spaces, dots, dashes and underscores, and must start with a letter or digit.`);
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug === "") throw new Error(`name "${name}" has no letters or digits to build a slug from.`);
  return {
    name,
    slug,
    prefix: slug.replaceAll("-", "_"),
    Prefix: pascal(slug),
    node: answers.node ?? DEFAULT_NODE,
    php: PLUGIN_PHP,
    standardsRef: answers.standardsRef ?? STANDARDS_REF,
  };
}

function fill(text: string, tokens: Record<string, string>, source: string): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = tokens[key];
    if (value === undefined) throw new Error(`template ${source} uses the unknown token {{${key}}}.`);
    return value;
  });
}

function listTemplates(root: string, relative = ""): string[] {
  return readdirSync(`${root}${relative}`, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) return listTemplates(root, path);
      return entry.name.endsWith(".tmpl") ? [path] : [];
    });
}

function targetPath(template: string): string {
  const path = template
    .replace(/\.tmpl$/, "")
    .split("/")
    .map((segment) => (segment.startsWith("dot-") ? `.${segment.slice(4)}` : segment))
    .join("/");
  return RENAMES[path] ?? path;
}

function fromDirectory(directory: string, tokens: Record<string, string>): PlannedFile[] {
  const root = `${templates}init/${directory}/`;
  return listTemplates(root).map((template) => ({
    path: fill(targetPath(template), tokens, template),
    content: fill(readFileSync(`${root}${template}`, "utf8"), tokens, template),
  }));
}

function workflow(answers: Answers, notes: string[]): PlannedFile {
  let text = readFileSync(`${templates}github/pipeline.yml`, "utf8");
  if (answers.pipelineRef) {
    text = text.replaceAll("REPLACE_WITH_SHA", answers.pipelineRef);
  } else {
    notes.push(
      "Replace both REPLACE_WITH_SHA values in .github/workflows/pipeline.yml with one commit of stormrockwell/dev-pipeline, or pass --pipeline-ref <sha> to init.",
    );
  }
  if (answers.peerReview === false) {
    text = text.replace(
      /^(\s*)# enforce-approvals: false.*$/m,
      "$1enforce-approvals: false  # One developer works here, so no peer exists. Remove this line when a second developer joins.",
    );
  }
  return { path: ".github/workflows/pipeline.yml", content: text };
}

function factsFor(type: ScaffoldType, answers: Answers, name: string): Facts {
  const base: Facts = {
    type,
    name,
    git: { defaultBranch: "main", commits: "conventional" },
    peerReview: answers.peerReview,
    tests: {},
    hasSuite: true,
    urls: answers.urls,
    packs: packsFor(type, [], false),
    extraPaths: [],
  };
  if (type === "node-site") {
    return { ...base, public: answers.public, node: answers.node ?? DEFAULT_NODE, tests: { js: "vitest", e2e: "playwright" } };
  }
  return { ...base, distributed: answers.distributed, php: PLUGIN_PHP, tests: { unit: "tests/Unit" } };
}

// Plans every file of a new project. The caller decides whether to write them.
export function scaffoldProject(answers: Answers, directory: string): Scaffold {
  const type = answers.type;
  if (type !== "node-site" && type !== "wordpress-plugin") {
    throw new Error(`a new project can be a node-site or a wordpress-plugin, not ${type}.`);
  }
  const tokens = tokensFor(answers, basename(directory));
  const notes: string[] = [];
  const facts = factsFor(type, answers, tokens.name!);

  const files: PlannedFile[] = [
    ...fromDirectory("common", tokens),
    ...fromDirectory(type, tokens),
    workflow(answers, notes),
    { path: ".github/pull_request_template.md", content: readFileSync(`${templates}github/pull_request_template.md`, "utf8") },
    { path: ".pipeline/profile.yml", content: renderProfile(facts) },
    { path: ".pipeline/sensitive.yml", content: renderSensitive(facts) },
  ];
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), facts, notes };
}
