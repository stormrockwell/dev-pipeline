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

test("the compound skill runs the efficiency miner and hands its report to the analyst", () => {
  const { fields, body } = frontmatter("skills/compound/SKILL.md");
  assert.equal(fields["disable-model-invocation"], "true");
  assert.match(body, /Route: compound/);
  assert.match(body, /pipeline compound efficiency --out \.pipeline\/compound\/efficiency\.json/);
  assert.match(body, /dev-pipeline:efficiency-analyst/);
  assert.match(body, /quality half is not built/);
  assert.ok(words(body) <= 250, `compound is ${words(body)} words`);
  assert.doesNotMatch(body, /—|–|\S - [a-z]/);
});

test("the efficiency analyst runs on sonnet, read-only, and proposes scripts only for mechanics", () => {
  const { fields, body } = frontmatter("agents/efficiency-analyst.md");
  assert.equal(fields.name, "efficiency-analyst");
  assert.equal(fields.model, "sonnet");
  const tools = fields.tools.split(",").map((tool) => tool.trim());
  for (const tool of ["Edit", "Write", "Bash", "Agent", "Task"]) assert.ok(!tools.includes(tool), `the analyst has no ${tool}`);
  for (const row of ["A stage that waits", "A loop that repeats", "A tool sequence that repeats", "A file every agent reads", "A flaky test or environment failure"]) assert.match(body, new RegExp(row), row);
  assert.match(body, /propose a script only for mechanics/);
  assert.match(body, /never estimate/);
  assert.match(body, /Measure:/);
  assert.ok(words(body) <= 600, `the analyst is ${words(body)} words`);
  assert.doesNotMatch(body, /—|–|\S - [a-z]/);
});
