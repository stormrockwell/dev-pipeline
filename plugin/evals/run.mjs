#!/usr/bin/env node
/**
 * Runs the plugin evals. `claude plugin eval` grants a gated tool only when both the case's
 * allowed_tools and the operator's --allow-tools name it, so this passes the union the cases
 * ask for and each case narrows it to its own route. tools/eval-bin goes first on PATH because the
 * sandboxed agent needs the git and pipeline shims there, and the sandbox hides the eval dir.
 *
 * --affected runs only the tags plugin/evals/affected.mjs picks from the branch's changes against
 * origin/main, committed or not, so a run spends plan usage only on cases the change can move.
 *
 * Usage: node plugin/evals/run.mjs --runs 3 --model sonnet --case 'routes-*'
 *        node plugin/evals/run.mjs --runs 1 --model sonnet --affected
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { affectedTags } from "./affected.mjs";

const evalsDir = dirname(fileURLToPath(import.meta.url));
const gated = /^(Bash|Write|Edit|NotebookEdit|WebFetch|mcp__)/;
const plainBash = /^Bash(\(\s*\*?\s*(:\s*\*)?\s*\))?$/;

export function caseDirs(dir = evalsDir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name === "results") return [];
    const path = join(dir, entry.name);
    return existsSync(join(path, "prompt.md")) ? [path] : caseDirs(path);
  });
}

export function allowedTools(caseDir) {
  const text = readFileSync(join(caseDir, "prompt.md"), "utf8");
  const line = text.match(/^---\n[\s\S]*?^allowed_tools:\s*\[(.*)\]\s*$/m);
  return line ? line[1].split(",").map((tool) => tool.trim()).filter(Boolean) : [];
}

export function operatorGrants(dir = evalsDir) {
  const grants = new Set();
  for (const caseDir of caseDirs(dir)) {
    for (const tool of allowedTools(caseDir)) {
      if (plainBash.test(tool)) throw new Error(`${caseDir} asks for plain Bash; grant a command pattern instead.`);
      if (gated.test(tool)) grants.add(tool);
    }
  }
  return [...grants].sort();
}

/**
 * The files the branch changes against origin/main, including uncommitted and untracked ones
 */
export function changedFiles(cwd = resolve(evalsDir, "../..")) {
  const git = (args) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  return [...new Set([...git(["diff", "--name-only", "origin/main...HEAD"]), ...git(["diff", "--name-only", "HEAD"]), ...git(["ls-files", "--others", "--exclude-standard"])])];
}

/**
 * Replaces --affected with one --tag per affected tag, or returns null when no case is affected
 */
export function expandAffected(argv, files) {
  if (!argv.includes("--affected")) return argv;
  const tags = affectedTags(files);
  if (tags.length === 0) return null;
  return [...argv.filter((arg) => arg !== "--affected"), "--tag", ...tags];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = expandAffected(process.argv.slice(2), process.argv.includes("--affected") ? changedFiles() : []);
  if (argv === null) {
    console.log("No eval case is affected by this branch's changes.");
    process.exit(0);
  }
  if (process.argv.includes("--affected")) console.log(`Affected tags: ${argv.slice(argv.indexOf("--tag") + 1).join(" ")}`);
  const args = [
    "plugin",
    "eval",
    resolve(evalsDir, ".."),
    "--trust-plugin",
    "--scaffold",
    "--ablation",
    "none",
    "--no-publish",
    "--eval-dir",
    "evals",
    ...argv,
    "--allow-tools",
    ...operatorGrants(),
  ];
  const env = { ...process.env, PATH: [resolve(evalsDir, "../../tools/eval-bin"), process.env.PATH].join(delimiter) };
  const result = spawnSync("claude", args, { stdio: "inherit", env });
  process.exit(result.status ?? 1);
}
