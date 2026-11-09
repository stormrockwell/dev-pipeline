import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Zone } from "../scan-zones/types.ts";

export type ProjectType = "wordpress-plugin" | "wordpress-theme" | "node-site" | "node-library" | "unknown";

export interface Detection {
  type: ProjectType;
  name?: string;
  // Each line names a file or field that led to the call, so the findings can be shown to the developer.
  evidence: string[];
  languages: string[];
  packageManagers: string[];
  framework?: string;
  versions: { php?: string; node?: string };
  tests: { unit?: string; integration?: string; js?: string; e2e?: string; files: number };
  linters: string[];
  ci: { workflows: string[]; pipeline: boolean };
  git: { isRepo: boolean; defaultBranch?: string; commits: "conventional" | "free" | "unknown" };
  codeowners: boolean;
  prTemplate: boolean;
  // Directories whose names call for a path rule that the built in packs do not already carry.
  zoneDirs: { glob: string; zone: Zone }[];
}

type Json = Record<string, unknown>;

const SKIPPED_DIRS = new Set(["node_modules", "vendor", ".git", "dist", "build", ".next", "coverage"]);
const MAX_FILES = 5000;
const MAX_DEPTH = 8;

const FRAMEWORKS = [
  "next",
  "nuxt",
  "astro",
  "@sveltejs/kit",
  "svelte",
  "@remix-run/react",
  "gatsby",
  "@angular/core",
  "@11ty/eleventy",
  "express",
  "fastify",
  "koa",
  "hono",
  "vite",
  "react",
  "vue",
];

// Directory names that deserve a path rule, kept to the ones the built in packs do not cover.
const ZONE_DIRS: Record<string, Zone> = {
  billing: "privacy",
  payments: "privacy",
  checkout: "privacy",
  webhooks: "input",
  webhook: "input",
};

const ESLINT_CONFIGS = /^(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[a-z]+)?)$/;
const STYLELINT_CONFIGS = /^(\.stylelintrc(\.[a-z]+)?|stylelint\.config\.[cm]?js)$/;
const PRETTIER_CONFIGS = /^(\.prettierrc(\.[a-z]+)?|prettier\.config\.[cm]?[jt]s)$/;

function read(dir: string, path: string): string | undefined {
  try {
    return readFileSync(join(dir, path), "utf8");
  } catch {
    return undefined;
  }
}

function readJson(dir: string, path: string): Json | undefined {
  const text = read(dir, path);
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}

function isDir(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

function walk(root: string): string[] {
  const files: string[] = [];
  const visit = (relative: string, depth: number) => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) visit(path, depth + 1);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  visit("", 0);
  return files;
}

function git(dir: string, ...args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: /;

function detectGit(dir: string): Detection["git"] {
  if (!isDir(dir) || git(dir, "rev-parse", "--is-inside-work-tree") !== "true") {
    return { isRepo: false, commits: "unknown" };
  }
  const remoteHead = git(dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")?.replace(/^origin[/]/, "");
  const defaultBranch = remoteHead || git(dir, "symbolic-ref", "--short", "HEAD") || undefined;
  const subjects = (git(dir, "log", "-n", "50", "--format=%s") ?? "").split("\n").filter(Boolean);
  // Fewer than three commits say nothing about a habit.
  if (subjects.length < 3) return { isRepo: true, defaultBranch, commits: "unknown" };
  const conventional = subjects.filter((subject) => CONVENTIONAL.test(subject)).length;
  return { isRepo: true, defaultBranch, commits: conventional / subjects.length >= 0.6 ? "conventional" : "free" };
}

function majorMinor(text: string | undefined): string | undefined {
  return /(\d+(?:\.\d+)?)/.exec(text ?? "")?.[1];
}

interface PluginHeader {
  file: string;
  name: string;
  php?: string;
}

function pluginHeader(dir: string, files: string[]): PluginHeader | undefined {
  for (const file of files.filter((path) => !path.includes("/") && path.endsWith(".php"))) {
    const head = (read(dir, file) ?? "").slice(0, 8192);
    const name = /^[^\w\n]*Plugin Name:[ \t]*(.+?)\s*$/im.exec(head)?.[1];
    if (name) return { file, name, php: majorMinor(/^[^\w\n]*Requires PHP:[ \t]*(.+?)\s*$/im.exec(head)?.[1]) };
  }
  return undefined;
}

function depNames(manifest: Json | undefined, ...fields: string[]): Set<string> {
  const names = new Set<string>();
  for (const field of fields) {
    const group = manifest?.[field];
    if (typeof group === "object" && group !== null) Object.keys(group).forEach((name) => names.add(name));
  }
  return names;
}

function nodeVersion(dir: string, manifest: Json | undefined): string | undefined {
  const fromFile =
    majorMinor(read(dir, ".nvmrc")?.trim().replace(/^v/, "")) ??
    majorMinor(read(dir, ".node-version")?.trim().replace(/^v/, "")) ??
    majorMinor(/^node(?:js)?\s+(\S+)/m.exec(read(dir, ".tool-versions") ?? "")?.[1]);
  const engines = manifest?.engines;
  const fromEngines =
    typeof engines === "object" && engines !== null ? majorMinor(String((engines as Json).node ?? "")) : undefined;
  return (fromFile ?? fromEngines)?.split(".")[0];
}

function detectTests(dir: string, files: string[], manifest: Json | undefined, deps: Set<string>): Detection["tests"] {
  const tests: Detection["tests"] = {
    files: files.filter((file) => /Test\.php$/.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)).length,
  };

  const config = read(dir, "phpunit.xml") ?? read(dir, "phpunit.xml.dist");
  const listed = [...(config ?? "").matchAll(/<directory[^>]*>([^<]+)<\/directory>/g)]
    .map((match) => match[1]!.trim().replace(/^\.\//, "").replace(/\/$/, ""))
    .filter((path) => isDir(join(dir, path)));
  tests.unit = listed.find((path) => /unit/i.test(path));
  tests.integration = listed.find((path) => /integr/i.test(path));
  if (!tests.unit && !tests.integration && listed.length === 1) tests.unit = listed[0];
  for (const [field, name] of [["unit", "tests/Unit"], ["integration", "tests/Integration"]] as const) {
    if (!tests[field] && isDir(join(dir, name))) tests[field] = name;
  }

  const hasFile = (pattern: RegExp) => files.some((file) => !file.includes("/") && pattern.test(file));
  if (deps.has("vitest") || hasFile(/^vitest\.config\./)) tests.js = "vitest";
  else if (deps.has("jest") || deps.has("@wordpress/scripts") || hasFile(/^jest\.config\./)) tests.js = "jest";
  else if (deps.has("mocha")) tests.js = "mocha";
  else if (/node --test/.test(JSON.stringify(manifest?.scripts ?? ""))) tests.js = "node:test";

  if (deps.has("@playwright/test") || deps.has("playwright") || hasFile(/^playwright\.config\./)) tests.e2e = "playwright";
  else if (deps.has("cypress") || hasFile(/^cypress\.config\./)) tests.e2e = "cypress";
  return tests;
}

function detectLinters(files: string[], manifest: Json | undefined, deps: Set<string>, composer: Set<string>): string[] {
  const roots = files.filter((file) => !file.includes("/"));
  const named = (pattern: RegExp) => roots.some((file) => pattern.test(file));
  const linters: string[] = [];
  if (named(/^\.?phpcs\.xml(\.dist)?$/) || composer.has("squizlabs/php_codesniffer")) linters.push("phpcs");
  if (named(/^phpstan\.neon(\.dist)?$/) || composer.has("phpstan/phpstan")) linters.push("phpstan");
  if (named(/^psalm\.xml(\.dist)?$/) || composer.has("vimeo/psalm")) linters.push("psalm");
  if (named(ESLINT_CONFIGS) || deps.has("eslint") || (manifest !== undefined && "eslintConfig" in manifest)) linters.push("eslint");
  if (named(STYLELINT_CONFIGS) || deps.has("stylelint") || (manifest !== undefined && "stylelint" in manifest)) linters.push("stylelint");
  if (named(PRETTIER_CONFIGS) || deps.has("prettier") || (manifest !== undefined && "prettier" in manifest)) linters.push("prettier");
  return linters;
}

function detectLanguages(files: string[]): string[] {
  const has = (test: (file: string) => boolean) => files.some(test);
  const languages: string[] = [];
  if (has((file) => /\.(php|phtml|inc)$/.test(file))) languages.push("php");
  if (has((file) => /\.(ts|tsx|mts|cts)$/.test(file) && !file.endsWith(".d.ts"))) languages.push("typescript");
  if (has((file) => /\.(js|jsx|mjs|cjs)$/.test(file))) languages.push("javascript");
  if (has((file) => /\.(css|scss)$/.test(file))) languages.push("css");
  return languages;
}

function detectPackageManagers(dir: string, manifest: Json | undefined, composer: Json | undefined): string[] {
  const managers: string[] = [];
  if (manifest !== undefined) {
    const declared = typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] : undefined;
    const locks: [string, string][] = [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lock", "bun"],
      ["bun.lockb", "bun"],
      ["package-lock.json", "npm"],
    ];
    managers.push(declared ?? locks.find(([lock]) => existsSync(join(dir, lock)))?.[1] ?? "npm");
  }
  if (composer !== undefined) managers.push("composer");
  return managers;
}

function detectCi(dir: string, files: string[]): Detection["ci"] {
  const workflows = files.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file));
  const others = [".gitlab-ci.yml", ".circleci/config.yml", "bitbucket-pipelines.yml"].filter((file) => files.includes(file));
  const pipeline = workflows.some((file) => (read(dir, file) ?? "").includes("dev-pipeline/.github/workflows/pipeline-pr.yml"));
  return { workflows: [...workflows, ...others], pipeline };
}

function detectZoneDirs(files: string[]): Detection["zoneDirs"] {
  const found = new Set<string>();
  for (const file of files) {
    for (const segment of file.split("/").slice(0, -1)) {
      if (segment in ZONE_DIRS) found.add(segment);
    }
  }
  return [...found].sort().map((name) => ({ glob: `**/${name}/**`, zone: ZONE_DIRS[name]! }));
}

function classify(
  dir: string,
  files: string[],
  manifest: Json | undefined,
  deps: Set<string>,
  composer: Json | undefined,
  header: PluginHeader | undefined,
): { type: ProjectType; name?: string; framework?: string; evidence: string[] } {
  if (header) return { type: "wordpress-plugin", name: header.name, evidence: [`Plugin Name header in ${header.file}`] };

  const themeName = /^\s*Theme Name:\s*(.+?)\s*$/im.exec(read(dir, "style.css")?.slice(0, 8192) ?? "")?.[1];
  if (themeName) return { type: "wordpress-theme", name: themeName, evidence: ["Theme Name header in style.css"] };
  if (composer?.type === "wordpress-plugin") return { type: "wordpress-plugin", evidence: ["composer.json type wordpress-plugin"] };

  const name = typeof manifest?.name === "string" ? manifest.name : undefined;
  if (manifest === undefined) return { type: "unknown", evidence: [] };

  const framework = FRAMEWORKS.find((candidate) => deps.has(candidate));
  if (framework) return { type: "node-site", name, framework, evidence: [`${framework} in package.json`] };

  const entry = ["main", "exports", "bin", "module", "types"].find((field) => field in manifest);
  if (entry) return { type: "node-library", name, evidence: [`${entry} field in package.json`] };

  const scripts = typeof manifest.scripts === "object" && manifest.scripts !== null ? Object.keys(manifest.scripts) : [];
  if (files.includes("index.html") || scripts.some((script) => script === "start" || script === "dev")) {
    return { type: "node-site", name, evidence: ["a start script or index.html"] };
  }
  return { type: "unknown", name, evidence: [] };
}

// Reads a directory the way a developer would before answering questions about it.
export function detectProfile(dir: string): Detection {
  const files = isDir(dir) ? walk(dir) : [];
  const manifest = readJson(dir, "package.json");
  const composer = readJson(dir, "composer.json");
  const deps = depNames(manifest, "dependencies", "devDependencies");
  const composerDeps = depNames(composer, "require", "require-dev");

  const header = pluginHeader(dir, files);
  const identity = classify(dir, files, manifest, deps, composer, header);
  const composerPhp = majorMinor(String((composer?.require as Json | undefined)?.php ?? ""));

  return {
    type: identity.type,
    name: identity.name ?? (files.length > 0 ? basename(dir) : undefined),
    evidence: identity.evidence,
    languages: detectLanguages(files),
    packageManagers: detectPackageManagers(dir, manifest, composer),
    framework: identity.framework,
    versions: { php: header?.php ?? composerPhp, node: nodeVersion(dir, manifest) },
    tests: detectTests(dir, files, manifest, deps),
    linters: detectLinters(files, manifest, deps, composerDeps),
    ci: detectCi(dir, files),
    git: detectGit(dir),
    codeowners: ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"].some((path) => files.includes(path)),
    prTemplate: files.some((file) => /^(\.github\/|docs\/)?pull_request_template\.md$/i.test(file)),
    zoneDirs: detectZoneDirs(files),
  };
}
