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
const docs = () => frontmatter("agents/docs.md");
const finish = () => frontmatter("skills/finish/SKILL.md");

test("the docs agent writes on sonnet and can neither edit files nor dispatch agents", () => {
  const { fields } = docs();
  assert.equal(fields.name, "docs");
  assert.equal(fields.model, "sonnet");
  const tools = fields.tools.split(",").map((tool) => tool.trim());
  for (const tool of ["Read", "Bash"]) assert.ok(tools.includes(tool), tool);
  for (const tool of ["Agent", "Task", "Write", "Edit"]) assert.ok(!tools.includes(tool), `${tool} is not the docs agent's to use`);
});

test("the docs agent writes from the work order, ledger, gate record and diff, never the transcript", () => {
  const { body } = docs();
  for (const source of ["work order", "pipeline ledger", "gate-record", "git diff"]) assert.match(body, new RegExp(source), source);
  assert.match(body, /transcript[^.]*never/i);
  assert.match(body, /Title: type\(scope\): subject/);
  for (const section of ["What changed", "Why this approach", "How to verify", "Risk"]) assert.match(body, new RegExp(`## ${section}`), section);
  assert.match(body, /Leave out the Human review line[^.]*Auditors/);
  assert.ok(words(body) <= 500, `the docs prompt is ${words(body)} words`);
});

test("finish asks before it pushes, opens drafts only, and never merges", () => {
  const { fields, body } = finish();
  assert.equal(fields.name, "finish");
  assert.equal(fields["disable-model-invocation"], undefined, "review hands off to finish by name");
  assert.ok(fields.description.length <= 300, "the description loads into every session");
  assert.match(body, /\(y\/N\)/);
  assert.match(body, /Ask at every involvement level/);
  assert.match(body, /gh pr create --draft/);
  assert.doesNotMatch(body, /gh pr (merge|ready)|--force|push -f/);
  assert.ok(body.indexOf("(y/N)") < body.indexOf("git -C <path> push"), "the question comes before the push");
});

test("finish drives the scripts for versions, the body and labels", () => {
  const { body } = finish();
  for (const command of [
    "pipeline ledger .pipeline/work/<slug>/work-order.md",
    "pipeline schedule .pipeline/work/<slug>/work-order.md --range",
    "pipeline version-sync changelog",
    "pipeline version-sync --dir",
    "pipeline pr-body .pipeline/work/<slug>/work-order.md --pr <pr>",
    "dev-pipeline:docs",
    "--label",
  ]) {
    assert.ok(body.includes(command), command);
  }
  assert.ok(words(body) <= 650, `finish body is ${words(body)} words`);
});

test("the docs agent and finish carry no time estimates or mid-sentence dashes", () => {
  for (const text of [docs().body, finish().body]) {
    assert.doesNotMatch(text, /\b\d+\s*(minutes?|hours?|days?|weeks?)\b|\bestimated? time\b/i);
    assert.doesNotMatch(text, /—|–|\S - [a-z]/);
  }
});
