import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { commit, git, makeRepo, pipeline, removeTemps, stage, tempDir, write } from "../helpers/repo.ts";

afterAll(removeTemps);

const workOrder = `---
title: Add a CSV export to the orders page
tasks:
  - id: 1
    title: CSV formatter
    files: [includes/csv.php, tests/test-csv.php]
    needs: []
    interfaces: [shop_csv()]
    state: []
    tier: T2
  - id: 2
    title: Export route and permission check
    files: [includes/export.php]
    needs: [1]
    interfaces: [shop_csv()]
    state: []
    tier: T2
---

# Add a CSV export to the orders page
`;

function repoWithPlan(plan = workOrder): string {
  const dir = tempDir();
  write(dir, "includes/csv.php", "<?php\nfunction shop_csv( $rows ) { return ''; }\n");
  write(dir, "includes/export.php", "<?php\nif ( current_user_can( 'manage_options' ) ) {}\n");
  write(dir, ".pipeline/work/csv/work-order.md", plan);
  return dir;
}

describe("pipeline schedule", () => {
  it("prints the one-screen work order", () => {
    const dir = repoWithPlan();
    const { stdout, status } = pipeline(dir, ["schedule", ".pipeline/work/csv/work-order.md"]);
    expect(status).toBe(0);
    expect(stdout).toBe(
      [
        "Work order: Add a CSV export to the orders page",
        "Task 1   CSV formatter                       T2  TDD, simplifier, standards, spec, quick security review",
        "Task 2   Export route and permission check   T3  zone:authz  TDD and security tests, simplifier proposals only, standards, spec, full security review with verifier vote",
        "PR A     task 1, standard, 1 peer approval",
        "PR B     task 2, zone, 1 peer approval, stacked on PR A",
        "Order    1, then 2 (needs 1)",
        "Kept     task 2 stays T3 with zone authz: the work order said T2, and only a peer can lower a tier or remove a zone",
        "Confirm  needed, level confirm",
        'Reply "go", or edit a line.',
        "",
      ].join("\n"),
    );
    expect(stdout.split("\n").length).toBeLessThanOrEqual(25);
  });

  it("prints the plan as JSON", () => {
    const dir = repoWithPlan();
    const { stdout, status } = pipeline(dir, ["schedule", ".pipeline/work/csv/work-order.md", "--json"]);
    expect(status).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.order.waves).toEqual([["1"], ["2"]]);
    expect(plan.prs.map((pr: { path: string }) => pr.path)).toEqual(["standard", "zone"]);
  });

  it("says when autopilot skips the confirmation", () => {
    const dir = repoWithPlan(workOrder.replace("title: Add", "level: autopilot\ntitle: Add").replace("includes/export.php", "includes/other.php"));
    const { stdout } = pipeline(dir, ["schedule", ".pipeline/work/csv/work-order.md"]);
    expect(stdout).toContain("Confirm  skipped, autopilot and no T3 task, so the build starts now");
    expect(stdout).not.toContain("Reply");
  });

  it("exits 1 and lists files the diff touched that no task owns", () => {
    const repo = makeRepo();
    write(repo, ".pipeline/work/csv/work-order.md", workOrder);
    stage(repo, "includes/csv.php", "<?php\nfunction shop_csv( $rows ) { return ''; }\n");
    stage(repo, "includes/orders-admin.php", "<?php\n$status = $_GET['status'];\n");
    commit(repo);
    const { stdout, status } = pipeline(repo, ["schedule", ".pipeline/work/csv/work-order.md", "--range", "HEAD~1..HEAD"]);
    expect(status).toBe(1);
    expect(stdout).toContain("Unplanned includes/orders-admin.php  T3  zone:input, owned by no task");
  });

  it("refuses a lowering signed by the repo's git user", () => {
    const repo = makeRepo();
    git(repo, "config", "user.name", "Dana Dev");
    write(repo, "includes/export.php", "<?php\nif ( current_user_can( 'manage_options' ) ) {}\n");
    write(
      repo,
      ".pipeline/work/x/work-order.md",
      "---\ntitle: x\ntasks:\n  - id: 1\n    title: Export\n    files: [includes/export.php]\n    tier: T2\n    zones: []\n    lowered_by: Dana Dev\n    lowered_reason: it is just a button\n---\n",
    );
    const { stdout, status } = pipeline(repo, ["schedule", ".pipeline/work/x/work-order.md"]);
    expect(status).toBe(1);
    expect(stdout).toContain("Refused  task 1 stays T3: Dana Dev cannot lower it");
  });

  it("records the plan beside the work order and holds its tiers on the next run", () => {
    const dir = repoWithPlan(workOrder.replace("    tier: T2\n  - id: 2", "    tier: T3\n    zones: [privacy]\n    raised: rows hold customer emails\n  - id: 2"));
    expect(pipeline(dir, ["schedule", ".pipeline/work/csv/work-order.md"]).status).toBe(0);
    const recorded = JSON.parse(readFileSync(join(dir, ".pipeline/work/csv/plan.json"), "utf8"));
    expect(recorded.tasks[0]).toMatchObject({ id: "1", tier: "T3", zones: ["privacy"] });

    write(dir, ".pipeline/work/csv/work-order.md", workOrder);
    const { stdout } = pipeline(dir, ["schedule", ".pipeline/work/csv/work-order.md"]);
    expect(stdout).toContain("Kept     task 1 stays T3 with zone privacy: the work order said T2");
  });

  it("exits 2 with one line for a bad work order", () => {
    const dir = repoWithPlan("# no frontmatter\n");
    const { stderr, status } = pipeline(dir, ["schedule", ".pipeline/work/csv/work-order.md"]);
    expect(status).toBe(2);
    expect(stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(stderr).toContain("pipeline schedule:");
  });

  it("exits 2 without a work order path", () => {
    expect(pipeline(tempDir(), ["schedule"]).status).toBe(2);
  });
});
