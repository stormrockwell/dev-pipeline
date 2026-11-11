import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const harness = join(here, "fixtures/query-count/harness.php");
const hasPhp = spawnSync("php", ["--version"]).status === 0;

/**
 * Runs the named scenarios in the PHP harness and returns its JSON outcome
 */
function run(...scenarios) {
  const result = spawnSync("php", [harness, ...scenarios], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("a render with a constant query count passes", { skip: !hasPhp && "php is not installed" }, () => {
  assert.equal(run("constant").constant.failed, false);
});

test("a query per item fails and names both counts", { skip: !hasPhp && "php is not installed" }, () => {
  const { "n-plus-one": outcome } = run("n-plus-one");
  assert.equal(outcome.failed, true);
  assert.match(outcome.message, /Rendering 100 items ran 101 queries and 10 items ran 11/);
  assert.match(outcome.message, /query inside a loop/);
});

test("a fixed allowance covers one extra count query", { skip: !hasPhp && "php is not installed" }, () => {
  assert.equal(run("allowance").allowance.failed, false);
});

test("the query filter counts the same growth as num_queries", { skip: !hasPhp && "php is not installed" }, () => {
  assert.equal(run("filter").filter.failed, true);
});

test("the arrange step is not counted", { skip: !hasPhp && "php is not installed" }, () => {
  assert.equal(run("arrange-uncounted")["arrange-uncounted"].failed, false);
});

test("the helper is a template a bootstrap can copy, with a docblock on every method", () => {
  const source = readFileSync(join(here, "../../templates/testing/php/AssertsQueryCount.php"), "utf8");
  const methods = [...source.matchAll(/^\tprotected function (\w+)/gm)].length;
  const docblocks = [...source.matchAll(/\/\*\*\n(?:\t \*[^\n]*\n)+\t \*\/\n\tprotected function/g)].length;
  assert.equal(methods, 3);
  assert.equal(docblocks, methods);
  assert.doesNotMatch(source, /—|–|\S - [a-z]/);
});
