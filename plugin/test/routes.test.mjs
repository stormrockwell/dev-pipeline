import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

function frontmatter(path) {
  const match = read(path).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, `${path} has frontmatter`);
  const fields = Object.fromEntries(
    match[1].split("\n").map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
  return { fields, body: match[2] };
}

const words = (text) => text.split(/\s+/).filter(Boolean).length;

const routes = {
  answer: "answer",
  "quick-change": "quick change",
  report: "report",
  debug: "debug",
  spike: "spike",
};
const writingRoutes = ["quick-change", "debug", "spike"];

test("each route skill is user-invoked, names its route and stays short", () => {
  for (const [name, route] of Object.entries(routes)) {
    const { fields, body } = frontmatter(`skills/${name}/SKILL.md`);
    assert.equal(fields.name, name);
    assert.ok(fields.description, `${name} has a description`);
    assert.equal(fields["disable-model-invocation"], "true", `${name} costs no context until the router reads it`);
    assert.match(body, new RegExp(`Route: ${route}`), `${name} names its route`);
    assert.ok(words(body) <= 400, `${name} body is ${words(body)} words`);
  }
});

test("the router starts each route from its skill", () => {
  const { body } = frontmatter("skills/router/SKILL.md");
  for (const [name, route] of Object.entries(routes)) {
    const row = body.split("\n").find((line) => line.startsWith(`| ${route} |`));
    assert.ok(row, `router has a ${route} row`);
    assert.ok(row.includes(`skills/${name}/SKILL.md`), `the ${route} row points at its skill`);
  }
});

test("routes that write change files with Edit and Write, never the shell", () => {
  for (const name of writingRoutes) {
    const { body } = frontmatter(`skills/${name}/SKILL.md`);
    assert.match(body, /Edit and Write tools/, `${name} names the file tools`);
    assert.match(body, /sed -i/, `${name} rules out sed -i`);
    assert.match(body, /redirect/, `${name} rules out shell redirection`);
  }
});

test("quick change and spike branch before editing and never merge", () => {
  assert.match(frontmatter("skills/quick-change/SKILL.md").body, /pipeline check/);
  const spike = frontmatter("skills/spike/SKILL.md").body;
  assert.match(spike, /spike\/<name>/);
  assert.match(spike, /never merges/);
});

test("the report goes outside the repo and has a writer brief", () => {
  const { body } = frontmatter("skills/report/SKILL.md");
  assert.match(body, /~\/pipeline-reports/);
  assert.match(body, /writer\.md/);
  assert.ok(existsSync(join(root, "skills/report/writer.md")));
});

test("debug reproduces before fixing and keeps remote sites read-only", () => {
  const { body } = frontmatter("skills/debug/SKILL.md");
  assert.match(body, /red/);
  assert.match(body, /read-only/);
  assert.match(body, /change route/);
});

function caseDirs(dir = join(root, "evals")) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name === "results") return [];
    const path = join(dir, entry.name);
    return existsSync(join(path, "prompt.md")) ? [path] : caseDirs(path);
  });
}

test("the eval runner grants only what the cases ask for, and never plain Bash", async () => {
  const { allowedTools, operatorGrants } = await import("../evals/run.mjs");
  const asked = new Set();
  for (const dir of caseDirs()) {
    const tools = allowedTools(dir);
    assert.ok(tools.length > 0, `${relative(root, dir)} lists allowed_tools`);
    for (const tool of tools) {
      assert.doesNotMatch(tool, /^Bash(\(\s*\*?\s*(:\s*\*)?\s*\))?$/, `${relative(root, dir)} grants plain Bash`);
      if (/^(Bash|Write|Edit|NotebookEdit|WebFetch|mcp__)/.test(tool)) asked.add(tool);
    }
  }
  assert.deepEqual(operatorGrants(join(root, "evals")), [...asked].sort());
  assert.throws(() => operatorGrants(join(root, "test/fixtures/plain-bash-evals")), /plain Bash/);
});

test("route cases grant per route and link the shared permission grader", () => {
  const routeCases = caseDirs(join(root, "evals/routes"));
  assert.ok(routeCases.length >= 4, "scenarios 3 and 4, quick change and spike");
  for (const dir of routeCases) {
    const grader = join(dir, "graders/no-refused-call.md");
    assert.ok(lstatSync(grader).isSymbolicLink(), `${relative(root, dir)} links the shared grader`);
    assert.equal(realpathSync(grader), join(realpathSync(root), "evals/shared-graders/no-refused-call.md"));
    const scaffold = join(dir, "scaffold.sh");
    assert.ok(statSync(scaffold).mode & 0o111, `${relative(root, dir)} has an executable scaffold`);
  }
});

test("the sandbox shims for git and pipeline are executable", () => {
  for (const name of ["git", "pipeline"]) {
    assert.ok(statSync(join(root, "../tools/eval-bin", name)).mode & 0o111, `${name} shim is executable`);
  }
});
