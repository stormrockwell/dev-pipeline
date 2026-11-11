import { describe, expect, it } from "vitest";
import type { Tier } from "../../src/commands/classify/tier.ts";
import { buildPlan, type PlanInput } from "../../src/commands/schedule/plan.ts";
import type { Task, WorkOrder } from "../../src/commands/schedule/work-order.ts";
import type { Zone } from "../../src/commands/scan-zones/types.ts";

const ORDER: Tier[] = ["T0", "T1", "T2", "T3"];

// Rules for the fake repo: a file's tier and zones come from this table.
const files: Record<string, { tier: Tier; zones: Zone[] }> = {
  "README.md": { tier: "T0", zones: [] },
  "style.css": { tier: "T1", zones: [] },
  "format.php": { tier: "T2", zones: [] },
  "button.php": { tier: "T2", zones: [] },
  "route.php": { tier: "T3", zones: ["authz"] },
  ".github/workflows/ci.yml": { tier: "T3", zones: ["guardrails"] },
};

function rules(paths: string[]) {
  let tier: Tier = "T0";
  const zones = new Set<Zone>();
  for (const path of paths) {
    const rule = files[path] ?? { tier: "T2", zones: [] };
    if (ORDER.indexOf(rule.tier) > ORDER.indexOf(tier)) tier = rule.tier;
    for (const zone of rule.zones) zones.add(zone);
  }
  return { tier, zones: [...zones].sort() };
}

function task(id: string, owned: string[], extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    files: owned,
    needs: [],
    interfaces: [],
    state: [],
    tier: null,
    zones: null,
    raised: null,
    joins: null,
    uncertain: false,
    loweredBy: null,
    loweredReason: null,
    ...extra,
  };
}

function plan(tasks: Task[], extra: Partial<PlanInput> & { level?: WorkOrder["level"] } = {}) {
  const { level = "confirm", ...rest } = extra;
  return buildPlan({ order: { title: "Work", level, tasks }, rules, critical: [".github/**"], authors: ["storm", "storm@example.com"], diff: null, previous: null, ...rest });
}

describe("tiers and gates", () => {
  it("gives a one-task work order one standard PR with one peer approval", () => {
    const result = plan([task("1", ["format.php"])]);
    expect(result.tasks).toEqual([
      expect.objectContaining({ id: "1", tier: "T2", rulesTier: "T2", zones: [], path: "standard", gates: ["TDD", "simplifier", "standards", "spec", "quick security review"] }),
    ]);
    expect(result.prs).toEqual([{ name: "A", tasks: ["1"], path: "standard", peers: 1, stacksOn: [] }]);
    expect(result.notes).toEqual([]);
  });

  it("starts T0 and T1 at one peer approval", () => {
    const result = plan([task("1", ["README.md"]), task("2", ["style.css"])]);
    expect(result.prs).toEqual([{ name: "A", tasks: ["1", "2"], path: "standard", peers: 1, stacksOn: [] }]);
    expect(result.tasks.map((planned) => planned.gates[0])).toEqual(["PR standard", "standards"]);
  });

  it("gives a T3 task the full security gates", () => {
    expect(plan([task("1", ["route.php"])]).tasks[0]!.gates).toEqual(["TDD and security tests", "simplifier proposals only", "standards", "spec", "full security review with verifier vote", "mutation check"]);
  });
});

describe("raising and lowering", () => {
  it("raises a task above the rules and records why", () => {
    const result = plan([task("1", ["button.php"], { tier: "T3", zones: ["privacy"], raised: "exports order data" })]);
    expect(result.tasks[0]).toMatchObject({ tier: "T3", rulesTier: "T2", zones: ["privacy"], path: "zone" });
    expect(result.notes).toEqual([{ kind: "raised", task: "1", text: "task 1 raised to T3: exports order data" }]);
  });

  it("keeps the rules tier when the work order records a lower one", () => {
    const result = plan([task("1", ["route.php"], { tier: "T2", zones: [] })]);
    expect(result.tasks[0]).toMatchObject({ tier: "T3", zones: ["authz"], path: "zone" });
    expect(result.notes).toEqual([
      { kind: "kept", task: "1", text: "task 1 stays T3 with zone authz: the work order said T2, and only a peer can lower a tier or remove a zone" },
    ]);
  });

  it("keeps a rules zone the work order left out", () => {
    const result = plan([task("1", ["route.php"], { tier: "T3", zones: ["input"] })]);
    expect(result.tasks[0]!.zones).toEqual(["authz", "input"]);
    expect(result.notes[0]!.kind).toBe("kept");
  });

  it("applies a peer's lowering and always prints it", () => {
    const result = plan([task("1", ["route.php"], { tier: "T2", zones: [], loweredBy: "alice", loweredReason: "reads public data only" })]);
    expect(result.tasks[0]).toMatchObject({ tier: "T2", zones: [], path: "standard" });
    expect(result.notes).toEqual([{ kind: "lowered", task: "1", text: "task 1 lowered from T3 to T2, zone authz removed, by alice: reads public data only" }]);
  });

  it.each(["storm", "Storm@Example.com", "claude", "dependabot[bot]", "the agent"])("refuses a lowering signed by %s", (by) => {
    const result = plan([task("1", ["route.php"], { tier: "T2", zones: [], loweredBy: by, loweredReason: "x" })]);
    expect(result.tasks[0]).toMatchObject({ tier: "T3", zones: ["authz"] });
    expect(result.notes).toEqual([
      { kind: "refused", task: "1", text: `task 1 stays T3: ${by} cannot lower it, because only a peer reviewer can, never the author or an agent` },
    ]);
  });
});

describe("the previous plan", () => {
  it("keeps a tier the last schedule raised, even when the rules alone say less", () => {
    const previous = new Map([["1", { tier: "T3" as Tier, zones: ["privacy" as Zone] }]]);
    const result = plan([task("1", ["button.php"], { tier: "T2", zones: [] })], { previous });
    expect(result.tasks[0]).toMatchObject({ tier: "T3", zones: ["privacy"], path: "zone" });
    expect(result.notes).toEqual([
      { kind: "kept", task: "1", text: "task 1 stays T3 with zone privacy: the work order said T2, and only a peer can lower a tier or remove a zone" },
    ]);
  });

  it("lets a peer lower below the last schedule", () => {
    const previous = new Map([["1", { tier: "T3" as Tier, zones: ["privacy" as Zone] }]]);
    const result = plan([task("1", ["button.php"], { tier: "T2", zones: [], loweredBy: "alice", loweredReason: "no personal data" })], { previous });
    expect(result.tasks[0]).toMatchObject({ tier: "T2", zones: [] });
    expect(result.notes[0]!.kind).toBe("lowered");
  });
});

describe("PR split", () => {
  it("puts a zone task in its own PR, apart from low-risk tasks", () => {
    const result = plan([task("1", ["format.php"]), task("2", ["route.php"]), task("3", ["style.css"])]);
    expect(result.prs).toEqual([
      { name: "A", tasks: ["2"], path: "zone", peers: 1, stacksOn: [] },
      { name: "B", tasks: ["1", "3"], path: "standard", peers: 1, stacksOn: [] },
    ]);
  });

  it("asks for two peers on a designated path", () => {
    expect(plan([task("1", [".github/workflows/ci.yml"])]).prs[0]!.peers).toBe(2);
  });

  it("stacks PRs by dependency and never lets a PR wait on itself", () => {
    const result = plan([task("1", ["format.php"]), task("2", ["route.php"], { needs: ["1"] }), task("3", ["button.php"], { needs: ["2"] })]);
    expect(result.prs).toEqual([
      { name: "A", tasks: ["1"], path: "standard", peers: 1, stacksOn: [] },
      { name: "B", tasks: ["2"], path: "zone", peers: 1, stacksOn: ["A"] },
      { name: "C", tasks: ["3"], path: "standard", peers: 1, stacksOn: ["B"] },
    ]);
  });

  it("lets a task that cannot stand alone join the PR it depends on, and says so", () => {
    const result = plan([task("1", ["route.php"]), task("2", ["button.php"], { needs: ["1"], joins: "1" })]);
    expect(result.prs).toEqual([{ name: "A", tasks: ["1", "2"], path: "zone", peers: 1, stacksOn: [] }]);
    expect(result.notes).toEqual([{ kind: "joined", task: "2", text: "task 2 rides in PR A with task 1, because it cannot stand alone" }]);
  });
});

describe("confirmation", () => {
  it("asks at guide and confirm levels", () => {
    expect(plan([task("1", ["format.php"])], { level: "guide" }).confirm).toEqual({ needed: true, reason: "level guide" });
    expect(plan([task("1", ["format.php"])]).confirm).toEqual({ needed: true, reason: "level confirm" });
  });

  it("skips the confirmation at autopilot below T3", () => {
    expect(plan([task("1", ["format.php"])], { level: "autopilot" }).confirm).toEqual({ needed: false, reason: "autopilot and no T3 task" });
  });

  it("still asks at autopilot for a T3 task, an uncertain task or a large plan", () => {
    expect(plan([task("1", ["route.php"])], { level: "autopilot" }).confirm).toEqual({ needed: true, reason: "task 1 is T3" });
    expect(plan([task("1", ["format.php"], { uncertain: true })], { level: "autopilot" }).confirm).toEqual({ needed: true, reason: "task 1 is uncertain" });
    const many = ["1", "2", "3", "4", "5", "6"].map((id) => task(id, [`f${id}.php`]));
    expect(plan(many, { level: "autopilot" }).confirm).toEqual({ needed: true, reason: "more than 5 tasks" });
  });
});

describe("the diff pass", () => {
  it("raises a task whose real diff touched zone code", () => {
    const result = plan([task("1", ["button.php"], { tier: "T2" })], { diff: [{ file: "button.php", tier: "T3", zones: ["input"] }] });
    expect(result.tasks[0]).toMatchObject({ tier: "T3", zones: ["input"], path: "zone" });
    expect(result.notes).toEqual([{ kind: "diff", task: "1", text: "task 1 raised to T3 by its diff: button.php in zone input" }]);
  });

  it("reports changed files that no task owns", () => {
    const result = plan([task("1", ["button.php"])], {
      diff: [
        { file: "button.php", tier: "T2", zones: [] },
        { file: "includes/orders-admin.php", tier: "T3", zones: ["input"] },
      ],
    });
    expect(result.unplanned).toEqual([{ file: "includes/orders-admin.php", tier: "T3", zones: ["input"] }]);
  });
});
