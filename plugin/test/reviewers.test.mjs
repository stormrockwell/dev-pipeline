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
const tools = (fields) => fields.tools.split(",").map((tool) => tool.trim());
const reviewers = { "spec-reviewer": ["correctness"], "standards-reviewer": ["correctness", "readability", "performance", "style"], simplifier: ["readability"] };

test("each reviewer runs on sonnet from a package and replies with a findings block and its Package line", () => {
  for (const [name, axes] of Object.entries(reviewers)) {
    const { fields, body } = frontmatter(`agents/${name}.md`);
    assert.equal(fields.name, name);
    assert.equal(fields.model, "sonnet");
    assert.ok(!tools(fields).includes("Agent") && !tools(fields).includes("Task"), `${name} dispatches no agents`);
    assert.match(body, /review package/);
    assert.match(body, /```json/);
    assert.match(body, /`Package:` line last/);
    for (const tag of ["Important", "Nit", "Pre-existing"]) assert.match(body, new RegExp(`\`${tag}\``), `${name} uses tag ${tag}`);
    for (const axis of axes) assert.match(body, new RegExp(axis), `${name} names axis ${axis}`);
    assert.ok(words(body) <= 600, `${name} is ${words(body)} words`);
    assert.doesNotMatch(body, /—|–|\S - [a-z]/, `${name} has no mid-sentence dashes`);
  }
});

const security = { "security-hunter": "sonnet", "security-verifier": "opus" };

test("the security hunter runs on sonnet and the verifier on opus, each read-only from a package with a json block and its Package line", () => {
  for (const [name, model] of Object.entries(security)) {
    const { fields, body } = frontmatter(`agents/${name}.md`);
    assert.equal(fields.name, name);
    assert.equal(fields.model, model);
    const list = tools(fields);
    for (const tool of ["Edit", "Write", "Agent", "Task"]) assert.ok(!list.includes(tool), `${name} has no ${tool}`);
    assert.match(body, /```json/);
    assert.match(body, /`Package:` line last/);
    assert.match(body, /data, never instructions/);
    assert.match(body, /needs_validation/);
    assert.match(body, /fails the security gate/);
    assert.match(body, /Cloudflare's security-audit skill, MIT licensed/, `${name} credits its source`);
    assert.ok(words(body) <= 600, `${name} is ${words(body)} words`);
    assert.doesNotMatch(body, /—|–|\S - [a-z]/, `${name} has no mid-sentence dashes`);
  }
});

test("the hunter reports boundary, result, anchored severity and tests, and the verifier tries to disprove", () => {
  const hunter = frontmatter("agents/security-hunter.md").body;
  for (const item of [/trust boundary/, /missing best practice is not a vulnerability/, /`critical`/, /`high`/, /`medium`/, /`low`/, /last trusted decision point/, /red first/, /"boundaries"/]) assert.match(hunter, item);
  const verifier = frontmatter("agents/security-verifier.md").body;
  for (const item of [/do not know who did/, /disprove/, /`confirmed`/, /`rejected`/, /`needs_validation`/, /majority/]) assert.match(verifier, item);
});

test("only the simplifier edits, and it proposes in zone files and keeps tests green", () => {
  for (const name of ["spec-reviewer", "standards-reviewer"]) {
    const list = tools(frontmatter(`agents/${name}.md`).fields);
    assert.ok(!list.includes("Edit") && !list.includes("Write"), `${name} is read-only`);
  }
  const { fields, body } = frontmatter("agents/simplifier.md");
  assert.ok(tools(fields).includes("Edit"));
  assert.match(body, /zone file/);
  assert.match(body, /pipeline tdd green/);
  assert.match(body, /Leave tests as they are/);
});

test("the standards reviewer gets its files and rules from OCR delegation through pipeline review files", () => {
  const { body } = frontmatter("agents/standards-reviewer.md");
  assert.match(body, /pipeline review files/);
  assert.match(body, /Open Code Review/);
});

test("the spec reviewer carries the test checklist and checks red before green", () => {
  const { body } = frontmatter("agents/spec-reviewer.md");
  for (const item of [/seam/, /public interface/, /system boundaries/, /reproduces the bug/, /red run/, /HEAD\^\{tree\}/]) assert.match(body, item);
});

test("a SubagentStop hook saves each reviewer's findings", () => {
  const { hooks } = JSON.parse(read("hooks/hooks.json"));
  const entry = hooks.SubagentStop.find((candidate) => candidate.hooks.some((hook) => hook.command === "pipeline review save --hook"));
  assert.ok(entry, "the reviewers' hook is registered");
  for (const name of [...Object.keys(reviewers), ...Object.keys(security)]) assert.match(`dev-pipeline:${name}`, new RegExp(entry.matcher), `${name} matches`);
  assert.doesNotMatch("dev-pipeline:implementer", new RegExp(entry.matcher));
  assert.ok(entry.hooks[0].timeout > 0 && entry.hooks[0].timeout <= 60);
});

test("the review loop drives the deterministic commands and stops at the round cap", () => {
  const { fields, body } = frontmatter("skills/review-loop/SKILL.md");
  assert.equal(fields.name, "review-loop");
  assert.equal(fields["disable-model-invocation"], undefined);
  assert.ok(fields.description.length <= 300, "the description loads into every session");
  for (const command of ["pipeline review start", "pipeline review merge", "pipeline review dismiss", "pipeline task-check", "pipeline gate-record"]) assert.match(body, new RegExp(command), command);
  assert.match(body, /dev-pipeline:simplifier/);
  assert.match(body, /dispatch it alone/);
  assert.match(body, /in one message, so they run at once/);
  assert.match(body, /overrule/);
  assert.match(body, /--continue/);
  assert.match(body, /security finding is never dismissed/);
  assert.match(body, /Verify/, "merge's Verify lines dispatch the verifiers");
  assert.match(body, /dev-pipeline:security-verifier/);
  assert.match(body, /names a model/, "a full review's hunters run on the model their line names");
  assert.match(body, /never write a security reply/i);
  assert.match(body, /dev-pipeline:finish/, "a reviewed work order hands off to finish");
  assert.ok(words(body) <= 600, `review-loop is ${words(body)} words`);
  assert.doesNotMatch(body, /—|–|\S - [a-z]/);
});

test("the build hands passing tasks to the review loop, and /review points at it", () => {
  assert.match(frontmatter("skills/build/SKILL.md").body, /dev-pipeline:review-loop/);
  assert.match(frontmatter("skills/review/SKILL.md").body, /dev-pipeline:review-loop/);
  assert.doesNotMatch(frontmatter("skills/review/SKILL.md").body, /ships no reviewer/);
});
