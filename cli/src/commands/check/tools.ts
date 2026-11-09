import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { probe } from "./exec.ts";
import { committableFiles } from "./scope.ts";

export interface ToolSpec {
  // Stable identifier used in output and in the JSON record.
  id: string;
  // Repo relative directory the tool runs in, for a tool that covers one lockfile of a nested project.
  subdir?: string;
  binary: string;
  // Project directories searched before PATH.
  localDirs: string[];
  hint: string;
  args(dir: string): string[];
  // Replaces `args` when the right arguments depend on the installed version.
  resolveArgs?(exe: string, dir: string): string[];
  // Runs the tool on the files the repo would commit instead of everything under the directory.
  committableOnly?: boolean;
}

const composerBin = ["vendor/bin"];
const nodeBin = ["node_modules/.bin"];

function has(dir: string, ...names: string[]): boolean {
  return names.some((name) => existsSync(join(dir, name)));
}

function packageJson(dir: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const phpcsConfigs = ["phpcs.xml", "phpcs.xml.dist", ".phpcs.xml", ".phpcs.xml.dist"];
const eslintConfigs = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
];
const stylelintConfigs = [
  ".stylelintrc",
  ".stylelintrc.js",
  ".stylelintrc.cjs",
  ".stylelintrc.mjs",
  ".stylelintrc.json",
  ".stylelintrc.yml",
  ".stylelintrc.yaml",
  "stylelint.config.js",
  "stylelint.config.cjs",
  "stylelint.config.mjs",
];

const phpcs: ToolSpec = {
  id: "phpcs",
  binary: "phpcs",
  localDirs: composerBin,
  hint: "composer require --dev squizlabs/php_codesniffer wp-coding-standards/wpcs",
  args: (dir) =>
    has(dir, ...phpcsConfigs)
      ? ["--report=summary"]
      : ["--report=summary", "--standard=WordPress", "--extensions=php", "--ignore=vendor/*,node_modules/*", "."],
};

const phpstan: ToolSpec = {
  id: "phpstan",
  binary: "phpstan",
  localDirs: composerBin,
  hint: "composer require --dev phpstan/phpstan",
  args: () => ["analyse", "--no-progress", "--no-interaction"],
};

const psalm: ToolSpec = {
  id: "psalm",
  binary: "psalm",
  localDirs: composerBin,
  hint: "composer require --dev vimeo/psalm",
  args: () => ["--taint-analysis", "--no-progress"],
};

const eslint: ToolSpec = {
  id: "eslint",
  binary: "eslint",
  localDirs: nodeBin,
  hint: "npm install --save-dev eslint",
  args: () => ["."],
};

const stylelint: ToolSpec = {
  id: "stylelint",
  binary: "stylelint",
  localDirs: nodeBin,
  hint: "npm install --save-dev stylelint",
  args: () => ["**/*.{css,scss}", "--allow-empty-input", "--ignore-pattern", "vendor/**"],
};

const composerAudit: ToolSpec = {
  id: "composer-audit",
  binary: "composer",
  localDirs: [],
  hint: "brew install composer",
  args: () => ["audit"],
};

const npmAudit: ToolSpec = {
  id: "npm-audit",
  binary: "npm",
  localDirs: [],
  hint: "install Node 24 or later, which ships npm",
  args: () => ["audit", "--omit=dev"],
};

const semgrep: ToolSpec = {
  id: "semgrep",
  binary: "semgrep",
  localDirs: [],
  hint: "brew install semgrep",
  args: () => [
    "scan",
    "--config",
    "p/php",
    "--config",
    "p/javascript",
    "--config",
    "p/secrets",
    "--error",
    "--quiet",
  ],
};

const gitleaks: ToolSpec = {
  id: "gitleaks",
  binary: "gitleaks",
  localDirs: [],
  hint: "brew install gitleaks",
  // Gitleaks walks the directory itself and has no notion of .gitignore, so it needs a filtered copy.
  committableOnly: true,
  args: () => ["dir", ".", "--no-banner", "--redact"],
  // The `dir` command arrived in 8.19, and older versions scan a plain directory with `detect --no-git`.
  resolveArgs: (exe, dir) =>
    probe(exe, ["dir", "--help"], dir)
      ? ["dir", ".", "--no-banner", "--redact"]
      : ["detect", "--no-git", "--source", ".", "--no-banner", "--redact"],
};

// Gives one lockfile its own row, so a nested project is named in the output and fails on its own.
function forSubdir(tool: ToolSpec, subdir: string): ToolSpec {
  return { ...tool, id: `${tool.id} ${subdir}`, subdir };
}

/**
 * Finds the directories below the root that hold a lockfile the repo would commit. Dependency
 * directories are skipped because they hold third party lockfiles that the project does not own.
 */
function nestedLockfileDirs(files: string[], lockfile: string): string[] {
  const dirs = files
    .filter((path) => path.endsWith(`/${lockfile}`))
    .map((path) => path.slice(0, -(lockfile.length + 1)))
    .filter((dir) => !dir.split("/").some((segment) => segment === "node_modules" || segment === "vendor"));
  return [...new Set(dirs)].sort();
}

// Returns the tools that apply to a repo, in the order they run.
export function detectTools(dir: string): ToolSpec[] {
  const manifest = packageJson(dir);
  const tools: ToolSpec[] = [];
  const files = committableFiles(dir) ?? [];

  if (has(dir, "composer.json", ...phpcsConfigs)) tools.push(phpcs);
  if (has(dir, "phpstan.neon", "phpstan.neon.dist")) tools.push(phpstan);
  if (has(dir, "psalm.xml")) tools.push(psalm);
  if (manifest && (has(dir, ...eslintConfigs) || "eslintConfig" in manifest)) tools.push(eslint);
  if (has(dir, ...stylelintConfigs) || (manifest && "stylelint" in manifest)) tools.push(stylelint);
  if (has(dir, "composer.lock")) tools.push(composerAudit);
  for (const sub of nestedLockfileDirs(files, "composer.lock")) tools.push(forSubdir(composerAudit, sub));
  if (has(dir, "package-lock.json")) tools.push(npmAudit);
  for (const sub of nestedLockfileDirs(files, "package-lock.json")) tools.push(forSubdir(npmAudit, sub));
  tools.push(semgrep, gitleaks);

  return tools;
}
