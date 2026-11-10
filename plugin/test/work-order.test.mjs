import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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

const skill = () => frontmatter("skills/work-order/SKILL.md");

test("the work order skill is model-invoked with a short description", () => {
  const { fields } = skill();
  assert.equal(fields.name, "work-order");
  assert.equal(fields["disable-model-invocation"], undefined);
  assert.ok(fields.description.length <= 300, "the description loads into every session");
  assert.match(fields.description, /work order/);
});

test("the work order skill body stays short", () => {
  const words = skill().body.split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 850, `work order body is ${words} words`);
});

test("the work order skill drives the deterministic commands", () => {
  const { body } = skill();
  assert.match(body, /pipeline classify --json <owned files>/);
  assert.match(body, /pipeline schedule \.pipeline\/work\/<slug>\/work-order\.md/);
  assert.match(body, /--range <base>\.\.HEAD/);
  assert.match(body, /git check-ignore/);
});

test("the work order skill keeps lowering with a peer", () => {
  const { body } = skill();
  assert.match(body, /Only a peer reviewer lowers a tier or removes a zone, never the author and never you/);
  assert.match(body, /lowered_by/);
});

test("the work order skill names every involvement level", () => {
  const { body } = skill();
  for (const level of ["guide", "confirm", "autopilot"]) assert.match(body, new RegExp(`^- \`${level}\`:`, "m"), level);
});

test("the work order format carries no time estimates and no mid-sentence dashes", () => {
  const { body } = skill();
  assert.doesNotMatch(body, /\b\d+\s*(minutes?|hours?|days?|weeks?)\b|\bestimated? time\b/i);
  assert.doesNotMatch(body, /—|–|\S - [a-z]/);
});

test("/work hands the change route to the work order skill", () => {
  const { body } = frontmatter("skills/work/SKILL.md");
  assert.match(body, /Route: change/);
  assert.match(body, /dev-pipeline:work-order/);
});

test("work order eval cases each grade a permission refusal", () => {
  const cases = readdirSync(join(root, "evals/work-order"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "fixtures")
    .map((entry) => entry.name);
  assert.ok(cases.length >= 5, `${cases.length} cases`);
  for (const name of cases) {
    const graders = readdirSync(join(root, "evals/work-order", name, "graders"));
    assert.ok(graders.includes("no-refused-tool.md"), `${name} grades refusals`);
    assert.match(read(`evals/work-order/${name}/prompt.md`), /^allowed_tools: \[/m, `${name} grants its own tools`);
  }
});
