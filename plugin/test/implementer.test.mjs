import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
const agent = () => frontmatter("agents/implementer.md");
const build = () => frontmatter("skills/build/SKILL.md");

test("the implementer runs on sonnet without the tools to dispatch agents", () => {
  const { fields } = agent();
  assert.equal(fields.name, "implementer");
  assert.equal(fields.model, "sonnet");
  const tools = fields.tools.split(",").map((tool) => tool.trim());
  for (const tool of ["Read", "Edit", "Write", "Bash"]) assert.ok(tools.includes(tool), tool);
  for (const tool of ["Agent", "Task"]) assert.ok(!tools.includes(tool), `${tool} lets the implementer spawn its own reviewers`);
  assert.equal(fields.hooks, undefined, "plugin agents ignore hooks, so the Stop hook lives in hooks.json");
});

test("the implementer works from its brief and the report contract", () => {
  const { body } = agent();
  assert.match(body, /brief/);
  assert.match(body, /pipeline tdd red/);
  assert.match(body, /pipeline tdd green/);
  assert.match(body, /pipeline task-check/);
  for (const status of ["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_CONTEXT"]) assert.match(body, new RegExp(`\\b${status}\\b`), status);
  assert.match(body, /Task: <worktree>/);
  assert.match(body, /Superpowers/, "the prompt is adapted from Superpowers, MIT licensed");
  assert.ok(words(body) <= 700, `the implementer prompt is ${words(body)} words`);
});

test("the Stop hook runs task-check for the implementer only", () => {
  const { hooks } = JSON.parse(read("hooks/hooks.json"));
  assert.equal(hooks.Stop, undefined, "a Stop hook would fire for every session");
  const [entry] = hooks.SubagentStop;
  assert.equal(entry.matcher, "^dev-pipeline:implementer$");
  const [hook] = entry.hooks;
  assert.equal(hook.type, "command");
  assert.equal(hook.command, "pipeline task-check --hook");
  assert.ok(hook.timeout > 0 && hook.timeout <= 120, "fast checks carry a hard timeout");
});

test("the build skill drives the deterministic commands for each task", () => {
  const { fields, body } = build();
  assert.equal(fields.name, "build");
  assert.equal(fields["disable-model-invocation"], undefined);
  assert.ok(fields.description.length <= 300, "the description loads into every session");
  assert.match(body, /pipeline worktree create/);
  assert.match(body, /pipeline brief \.pipeline\/work\/<slug>\/work-order\.md <id>/);
  assert.match(body, /dev-pipeline:implementer/);
  assert.match(body, /pipeline task-check --task/);
  assert.match(body, /BLOCKED/);
  assert.ok(words(body) <= 600, `build body is ${words(body)} words`);
});

test("the work order hands a confirmed plan to the build skill", () => {
  assert.match(frontmatter("skills/work-order/SKILL.md").body, /dev-pipeline:build/);
});

test("the implementer prompt and build skill carry no time estimates or mid-sentence dashes", () => {
  for (const text of [agent().body, build().body]) {
    assert.doesNotMatch(text, /\b\d+\s*(minutes?|hours?|days?|weeks?)\b|\bestimated? time\b/i);
    assert.doesNotMatch(text, /—|–|\S - [a-z]/);
  }
});
