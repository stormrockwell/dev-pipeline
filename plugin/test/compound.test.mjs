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

test("the compound skill runs both miners and hands each report to its analyst", () => {
  const { fields, body } = frontmatter("skills/compound/SKILL.md");
  assert.equal(fields["disable-model-invocation"], "true");
  assert.match(body, /Route: compound/);
  assert.match(body, /pipeline compound quality --out \.pipeline\/compound\/quality\.json/);
  assert.match(body, /pipeline compound efficiency --out \.pipeline\/compound\/efficiency\.json/);
  assert.match(body, /dev-pipeline:quality-analyst/);
  assert.match(body, /dev-pipeline:efficiency-analyst/);
  assert.match(body, /`--offline` to the quality command only/);
  assert.ok(words(body) <= 600, `compound is ${words(body)} words`);
  assert.doesNotMatch(body, /—|–|\S - [a-z]/);
});

test("the compound skill asks which halves the setting covers and the hook offers it at startup only", () => {
  const { body } = frontmatter("skills/compound/SKILL.md");
  assert.match(body, /pipeline compound due`/);
  assert.match(body, /ends `covers efficiency\.`/);
  assert.ok(body.indexOf("pipeline compound due") < body.indexOf("pipeline compound quality"), "the skill reads the setting first");
  const { hooks } = JSON.parse(read("hooks/hooks.json"));
  const reminders = hooks.SessionStart.filter((entry) => entry.hooks.some((hook) => hook.command === "pipeline compound due --hook"));
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].matcher, "startup");
  const [hook] = reminders[0].hooks;
  assert.ok(hook.timeout > 0 && hook.timeout <= 10, "the reminder runs at every start, so it is bounded");
  assert.notEqual(hook.async, true, "the reminder's output reaches the session only when it is not async");
});

test("the compound skill previews each issue, asks, and files only the lessons the developer names", () => {
  const { body } = frontmatter("skills/compound/SKILL.md");
  assert.match(body, /pipeline compound file --class <fingerprint> --lesson "<Lesson>" --becomes "<Becomes>" --dry-run/);
  assert.match(body, /pipeline compound file --finding "<Finding>" --target <Target> --becomes "<Change>" --dry-run/);
  assert.match(body, /`--to standards`/);
  assert.match(body, /lint rule or hook ahead of a line in the notes file/);
  assert.match(body, /asking which numbers to ship, and stop/);
  assert.match(body, /without `--dry-run`/);
  assert.match(body, /ready for a PR/);
  const preview = body.indexOf("--dry-run");
  const ask = body.indexOf("asking which numbers to ship");
  const send = body.indexOf("without `--dry-run`");
  assert.ok(preview < ask && ask < send, "the skill previews, then asks, then files");
});

test("the efficiency analyst names the fields the filing command takes", () => {
  const { body } = frontmatter("agents/efficiency-analyst.md");
  for (const field of ["Finding:", "Change:", "Target:", "Destination:"]) assert.match(body, new RegExp(field), field);
  assert.match(body, /public issue/);
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

test("the quality analyst runs on sonnet, read-only, and routes each lesson with the strategy's tables", () => {
  const { fields, body } = frontmatter("agents/quality-analyst.md");
  assert.equal(fields.name, "quality-analyst");
  assert.equal(fields.model, "sonnet");
  const tools = fields.tools.split(",").map((tool) => tool.trim());
  for (const tool of ["Edit", "Write", "Bash", "Agent", "Task"]) assert.ok(!tools.includes(tool), `the analyst has no ${tool}`);
  const strategy = readFileSync(join(root, "..", "docs", "STRATEGY.md"), "utf8");
  for (const row of ["Mechanical (a pattern, a banned API, a file location)", "Judgment (consistency, design taste)", "Missed sensitive code", "Wrong tier", "Navigation or missing information", "Instruction with no effect"]) {
    assert.ok(strategy.includes(`| ${row} |`), `STRATEGY.md still has the row ${row}`);
    assert.match(body, new RegExp(`\\| ${row.replace(/[()]/g, "\\$&")} \\|`), row);
  }
  for (const destination of ["the pipeline repo", "the standards repo", "the project"]) assert.match(body, new RegExp(`\\| ${destination} \\|`), destination);
  assert.match(body, /never estimate/);
  assert.match(body, /names no client, repo, path or code/);
  assert.match(body, /public issue/);
  assert.match(body, /fingerprint/);
  assert.ok(words(body) <= 600, `the analyst is ${words(body)} words`);
  assert.doesNotMatch(body, /—|–|\S - [a-z]/);
});
