import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { affectedTags } from "../evals/affected.mjs";

const plugin = join(dirname(fileURLToPath(import.meta.url)), "..");
const all = ["build", "finish", "review", "routes", "routing", "work-order"];

test("a skill or agent change selects only the cases that run it", () => {
  assert.deepEqual(affectedTags(["plugin/skills/review-loop/SKILL.md"]), ["review"]);
  assert.deepEqual(affectedTags(["plugin/agents/docs.md"]), ["finish"]);
  assert.deepEqual(affectedTags(["plugin/skills/quick-change/SKILL.md"]), ["routes", "routing"]);
});

test("a CLI change selects the cases whose skills run the command or its imports", () => {
  assert.deepEqual(affectedTags(["cli/src/commands/pr-body/index.ts"]), ["finish"]);
  assert.deepEqual(affectedTags(["cli/src/commands/classify/index.ts"]), ["routing", "work-order"]);
  assert.ok(affectedTags(["cli/src/ledger/ledger.ts"]).includes("build"));
});

test("a fixture change follows the scaffolds that source or link it", () => {
  assert.deepEqual(affectedTags(["plugin/evals/work-order/fixtures/shop.sh"]), ["work-order"]);
  assert.deepEqual(affectedTags(["plugin/evals/fixtures/node-shipping.sh"]), ["build", "finish", "review"]);
});

test("docs select nothing and the harness selects everything", () => {
  assert.deepEqual(affectedTags(["docs/HANDOFF.md", "README.md"]), []);
  assert.deepEqual(affectedTags(["plugin/evals/run.mjs"]), all);
});

test("every skill, agent and hook file has an owner, so none skips its evals", () => {
  const files = [
    ...readdirSync(join(plugin, "skills")).map((name) => `plugin/skills/${name}/SKILL.md`),
    ...readdirSync(join(plugin, "agents")).map((name) => `plugin/agents/${name}`),
    ...readdirSync(join(plugin, "hooks")).map((name) => `plugin/hooks/${name}`),
  ];
  for (const file of files) {
    if (file === "plugin/skills/compound/SKILL.md") continue;
    assert.notDeepEqual(affectedTags([file]), [], `${file} has no owner in plugin/evals/affected.mjs`);
  }
});

test("--affected becomes one --tag list, or nothing to run", async () => {
  const { expandAffected } = await import("../evals/run.mjs");
  assert.deepEqual(expandAffected(["--runs", "1"], []), ["--runs", "1"]);
  assert.deepEqual(expandAffected(["--runs", "1", "--affected"], ["plugin/agents/docs.md"]), ["--runs", "1", "--tag", "finish"]);
  assert.equal(expandAffected(["--affected"], ["docs/HANDOFF.md"]), null);
});
