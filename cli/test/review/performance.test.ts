import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validateFindings } from "../../src/review/findings.ts";
import { DEFAULT_SCALE, readScale } from "../../src/review/scale.ts";
import { pipeline, removeTemps, tempDir, write } from "../helpers/repo.ts";
import { brief, commitAll, fixShipping, taskRepo } from "../task/fixture.ts";

afterAll(removeTemps);

const order = ".pipeline/work/ship/work-order.md";

function checked(repo: string): void {
  const result = pipeline(repo, ["task-check"]);
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
}

const loop = "<?php\nforeach ( get_posts() as $post ) {\n\techo get_post_meta( $post->ID, 'price', true );\n}\n";

// A built and checked task 1, with a PHP file that loops over posts when `php` is given.
function shipped(php?: string): string {
  const repo = taskRepo();
  brief(repo);
  write(repo, "test/shipping.test.js", `${Array.from({ length: 15 }, (_, index) => `// Case ${index}.`).join("\n")}\n`);
  expect(pipeline(repo, ["tdd", "red"]).status).toBe(0);
  fixShipping(repo);
  if (php !== undefined) write(repo, "src/list.php", php);
  commitAll(repo);
  expect(pipeline(repo, ["tdd", "green"]).status).toBe(0);
  write(repo, ".pipeline/task/report.md", `Status: DONE\n\nAn order of exactly 75 ships free.\n${php !== undefined ? "\nUnplanned: src/list.php lists prices.\n" : ""}`);
  checked(repo);
  return repo;
}

const review = (repo: string, verb: string) => pipeline(repo, ["review", verb, order, "--task", "1", "--worktree", repo]);
const spec = { axis: "correctness", tag: "Important", file: "src/shipping.js", line: 1, title: "Wholesale orders lose free shipping", detail: "Every order type." };
const pkg = (repo: string, name: string, round = 1) => join(repo, `.pipeline/work/ship/review/task-1/round-${round}/package-${name}.md`);

describe("readScale", () => {
  it("assumes about 500 when the profile declares no scale", () => {
    const dir = tempDir();
    expect(readScale(dir)).toEqual({ fallback: DEFAULT_SCALE, entities: {}, declared: false });
    write(dir, ".pipeline/profile.yml", "project:\n  type: wordpress-plugin\n");
    expect(readScale(dir)).toEqual({ fallback: 500, entities: {}, declared: false });
  });

  it("reads the default and each entity ceiling, and ignores a value that is not a number", () => {
    const dir = tempDir();
    write(dir, ".pipeline/profile.yml", "scale:\n  default: 2000\n  orders: 100000\n  team_members: 50 # staff\n  vague: many\n");
    expect(readScale(dir)).toEqual({ fallback: 2000, entities: { orders: 100000, team_members: 50 }, declared: true });
  });

  it("falls back when the profile is not readable YAML", () => {
    const dir = tempDir();
    write(dir, ".pipeline/profile.yml", "scale: [unterminated\n  - &anchor x\n");
    expect(readScale(dir).fallback).toBe(500);
  });
});

describe("the performance axis", () => {
  const finding = { axis: "performance", tag: "Important", file: "src/list.php", line: 3, title: "get_post_meta runs once per post", detail: "One query per post." };

  it("belongs to the performance reviewer, which reports no other axis", () => {
    expect(validateFindings("performance", { findings: [finding] }, []).problems).toEqual([]);
    expect(validateFindings("performance", { findings: [{ ...finding, axis: "style" }] }, []).problems[0]).toContain("performance reports performance");
    expect(validateFindings("simplifier", { findings: [finding] }, []).problems[0]).toContain("simplifier reports readability");
  });
});

describe("pipeline review start with performance", () => {
  it("dispatches the performance reviewer when the diff loops over data, with the scale ceiling in its package", () => {
    const repo = shipped(loop);
    write(repo, ".pipeline/profile.yml", "scale:\n  default: 500\n  orders: 100000\n");
    const { status, stdout } = review(repo, "start");
    expect(status).toBe(0);
    expect(stdout).toContain(`Dispatch  dev-pipeline:performance-reviewer with ${pkg(repo, "performance")}`);
    expect(stdout).toContain("Why       performance: the diff has queries, loops or remote calls");
    expect(stdout).not.toContain("ships in 3.5");
    const text = readFileSync(pkg(repo, "performance"), "utf8");
    expect(text).toContain("Your axes");
    expect(text).toMatch(/Scale\s+about 500 by default, orders 100000/);
    expect(text).toContain("Package: ");
  });

  it("says 500 is an assumption when the profile has no scale", () => {
    const repo = shipped(loop);
    review(repo, "start");
    expect(readFileSync(pkg(repo, "performance"), "utf8")).toMatch(/Scale\s+about 500, assumed because the profile declares none/);
  });

  it("leaves the reviewer out when the diff has no queries, loops or remote calls", () => {
    const repo = shipped();
    expect(review(repo, "start").stdout).not.toContain("performance-reviewer");
  });

  it("saves the reviewer's reply and records its gate", () => {
    const repo = shipped(loop);
    review(repo, "start");
    const finding = { axis: "performance", tag: "Important", file: "src/list.php", line: 3, title: "get_post_meta runs once per post", detail: "One query per post.", fix: "Call update_meta_cache first." };
    for (const [name, findings] of [["simplifier", []], ["spec", []], ["standards", []], ["performance", [finding]], ["security-hunter-1", []]] as const) {
      const message = `Reviewed.\n\n\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\`\n\nPackage: ${pkg(repo, name)}`;
      expect(pipeline(repo, ["review", "save", "--hook"], { input: JSON.stringify({ hook_event_name: "SubagentStop", last_assistant_message: message }) }).stdout).toBe("");
    }
    const merged = review(repo, "merge");
    expect(merged.stdout).toContain("Gate      performance fail, 1 open");
    expect(readFileSync(join(repo, ".pipeline/work/ship/review/task-1/round-1/fix-list.md"), "utf8")).toContain("performance, Important, src/list.php:3");
  });

  it("leaves the reviewer out of a fix that adds no query, loop or remote call", () => {
    const repo = shipped(loop);
    review(repo, "start");
    for (const [name, findings] of [["simplifier", []], ["spec", [spec]], ["standards", []], ["performance", []], ["security-hunter-1", []]] as const) {
      const message = `Reviewed.\n\n\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\`\n\nPackage: ${pkg(repo, name)}`;
      pipeline(repo, ["review", "save", "--hook"], { input: JSON.stringify({ hook_event_name: "SubagentStop", last_assistant_message: message }) });
    }
    expect(review(repo, "merge").status).toBe(0);
    write(repo, "src/shipping.js", "export const freeShipping = (total, wholesale = false) => wholesale || total >= 75;\n");
    commitAll(repo, "fix(shipping): cover wholesale");
    expect(pipeline(repo, ["tdd", "green"]).status).toBe(0);
    checked(repo);
    expect(review(repo, "start").stdout).not.toContain("performance-reviewer");
  });

  it("wakes the reviewer for a fix that adds a query", () => {
    const repo = shipped();
    review(repo, "start");
    for (const [name, findings] of [["simplifier", []], ["spec", [spec]], ["standards", []], ["security-hunter-1", []]] as const) {
      const message = `Reviewed.\n\n\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\`\n\nPackage: ${pkg(repo, name)}`;
      pipeline(repo, ["review", "save", "--hook"], { input: JSON.stringify({ hook_event_name: "SubagentStop", last_assistant_message: message }) });
    }
    expect(review(repo, "merge").status).toBe(0);
    write(repo, "src/shipping.js", "export const freeShipping = (total, wholesale = false) => wholesale || total >= 75;\n// $wpdb->get_var( 'SELECT 1' );\n");
    commitAll(repo, "fix(shipping): cover wholesale");
    expect(pipeline(repo, ["tdd", "green"]).status).toBe(0);
    checked(repo);
    expect(review(repo, "start").stdout).toContain("Why       performance: the fix adds queries, loops or remote calls at src/shipping.js:2");
  });
});
