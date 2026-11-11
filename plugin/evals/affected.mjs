#!/usr/bin/env node
/**
 * Picks the eval tags a change can affect, so a run spends plan usage only on cases the diff could move.
 * Each plugin file owns a set of tags. A CLI command maps to every owner whose text runs
 * `pipeline <command>`, and a shared CLI module maps to every command that imports it,
 * directly or through another module. Eval infrastructure maps to every tag.
 *
 * Usage: node plugin/evals/affected.mjs <changed file>...
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const routed = ["routes", "routing"];

// The router picks a route skill by its description, so a route skill's change reaches routing too.
const OWNERS = {
  "plugin/skills/router/": ["routing"],
  "plugin/skills/work/": ["routing"],
  "plugin/hooks/session-start.json": ["routing"],
  "plugin/skills/answer/": ["routing"],
  "plugin/skills/quick-change/": routed,
  "plugin/skills/report/": routed,
  "plugin/skills/debug/": routed,
  "plugin/skills/spike/": routed,
  "plugin/skills/bootstrap/": routed,
  "plugin/skills/work-order/": ["work-order", "routing"],
  "plugin/skills/build/": ["build"],
  "plugin/agents/implementer.md": ["build", "review"],
  "plugin/hooks/hooks.json": ["build", "review"],
  "plugin/skills/review/": ["review"],
  "plugin/skills/review-loop/": ["review"],
  "plugin/agents/simplifier.md": ["review"],
  "plugin/agents/spec-reviewer.md": ["review"],
  "plugin/agents/standards-reviewer.md": ["review"],
  "plugin/agents/security-hunter.md": ["review", "security"],
  "plugin/agents/security-verifier.md": ["review", "security"],
  "plugin/skills/finish/": ["finish"],
  "plugin/agents/docs.md": ["finish"],
  "plugin/skills/compound/": [],
};

const EVERYTHING = ["plugin/evals/run.mjs", "plugin/evals/affected.mjs", "plugin/evals/shared-graders/", "tools/eval-bin/", "cli/src/main.ts", "cli/src/command.ts", "cli/package.json", "cli/package-lock.json"];

/**
 * Every file under a directory, as repo-relative paths
 */
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [relative(repo, path).split(sep).join("/")];
  });
}

const read = (path) => readFileSync(join(repo, path), "utf8");

/**
 * The tag of every eval case, taken from the folder that groups it
 */
function allTags() {
  return [...new Set(walk(join(repo, "plugin/evals")).filter((file) => file.endsWith("/prompt.md")).map((file) => file.split("/")[2]))].sort();
}

/**
 * The owner key a plugin file falls under, if any
 */
function ownerOf(file) {
  return Object.keys(OWNERS).find((key) => (key.endsWith("/") ? file.startsWith(key) : file === key));
}

/**
 * Maps each CLI command to the tags of the plugin files that run it
 */
function commandTags() {
  const tags = new Map();
  for (const key of Object.keys(OWNERS)) {
    const files = key.endsWith("/") ? walk(join(repo, key)) : [key];
    for (const file of files) {
      for (const [, command] of read(file).matchAll(/\bpipeline ([a-z][a-z-]*)/g)) {
        tags.set(command, new Set([...(tags.get(command) ?? []), ...OWNERS[key]]));
      }
    }
  }
  return tags;
}

/**
 * The CLI unit a source file belongs to: a command, a shared module folder, or a top-level file
 */
function cliUnit(file) {
  const parts = file.replace(/^cli\/src\//, "").split("/");
  return parts[0] === "commands" ? `commands/${parts[1]}` : parts[0];
}

/**
 * The commands that import a CLI unit, following imports through other shared modules
 */
function importingCommands(unit) {
  const importers = new Map();
  for (const file of walk(join(repo, "cli/src")).filter((path) => path.endsWith(".ts"))) {
    const from = cliUnit(file);
    for (const [, spec] of read(file).matchAll(/from\s+"(\.[^"]+)"/g)) {
      const target = cliUnit(relative(repo, resolve(repo, dirname(file), spec)).split(sep).join("/"));
      if (target !== from) importers.set(target, new Set([...(importers.get(target) ?? []), from]));
    }
  }
  const seen = new Set([unit]);
  const queue = [unit];
  while (queue.length > 0) {
    for (const next of importers.get(queue.shift()) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen].filter((name) => name.startsWith("commands/")).map((name) => name.slice("commands/".length));
}

/**
 * The tags of the cases whose scaffold runs a fixture
 *
 * Fixtures source one another and a case's scaffold.sh may be a symlink to one, so this follows
 * both until no new fixture turns up.
 */
function fixtureTags(fixture) {
  const evals = walk(join(repo, "plugin/evals"));
  const fixtures = evals.filter((file) => /\/fixtures\/[^/]+\.sh$/.test(file));
  const names = new Set([fixture.split("/").pop()]);
  const mentions = (file) => [...names].some((name) => read(file).includes(`/${name}`));
  for (let grew = true; grew; ) {
    grew = false;
    for (const file of fixtures) {
      const name = file.split("/").pop();
      if (names.has(name) || !mentions(file)) continue;
      names.add(name);
      grew = true;
    }
  }
  return evals
    .filter((file) => file.endsWith("/scaffold.sh"))
    .filter((file) => names.has(realpathSync(join(repo, file)).split(sep).pop()) || mentions(file))
    .map((file) => file.split("/")[2]);
}

/**
 * The sorted eval tags that a set of changed files can affect
 */
export function affectedTags(files) {
  const known = allTags();
  const tags = new Set();
  let commands;
  for (const file of files) {
    if (EVERYTHING.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path))) return known;
    const owner = ownerOf(file);
    if (owner) OWNERS[owner].forEach((tag) => tags.add(tag));
    else if (/^plugin\/evals\/(.+\/)?fixtures\//.test(file)) fixtureTags(file).forEach((tag) => tags.add(tag));
    else if (file.startsWith("plugin/evals/")) tags.add(file.split("/")[2]);
    else if (file.startsWith("cli/src/")) {
      commands ??= commandTags();
      const unit = cliUnit(file);
      const names = unit.startsWith("commands/") ? [unit.slice("commands/".length)] : importingCommands(unit);
      for (const name of names) (commands.get(name) ?? []).forEach((tag) => tags.add(tag));
    }
  }
  return [...tags].filter((tag) => known.includes(tag)).sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(affectedTags(process.argv.slice(2)).join(" "));
}
