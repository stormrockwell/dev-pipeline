import { describe, expect, it } from "vitest";
import { parseWorkOrder } from "../../src/commands/schedule/work-order.ts";

const one = `---
title: Raise the free shipping threshold
tasks:
  - id: 1
    title: Threshold constant
    files: [includes/shipping.php]
    tier: T2
---

# Raise the free shipping threshold
`;

describe("parseWorkOrder", () => {
  it("reads a one-task work order with defaults", () => {
    expect(parseWorkOrder(one)).toEqual({
      title: "Raise the free shipping threshold",
      level: "confirm",
      tasks: [
        {
          id: "1",
          title: "Threshold constant",
          files: ["includes/shipping.php"],
          needs: [],
          interfaces: null,
          state: null,
          tier: "T2",
          zones: null,
          raised: null,
          joins: null,
          uncertain: false,
          loweredBy: null,
          loweredReason: null,
        },
      ],
    });
  });

  it("reads the task graph fields", () => {
    const order = parseWorkOrder(`---
title: CSV export
level: autopilot
tasks:
  - id: 1
    title: Formatter
    files: [a.php]
    interfaces: [format()]
    state: []
  - id: 2
    title: Route
    files: [b.php]
    needs: [1]
    interfaces: [format()]
    state: []
    tier: T3
    zones: [authz]
    raised: exports order data
    joins: 1
    uncertain: true
    lowered_by: alice
    lowered_reason: reads public data only
---
`);
    expect(order.level).toBe("autopilot");
    expect(order.tasks[1]).toMatchObject({
      id: "2",
      needs: ["1"],
      interfaces: ["format()"],
      state: [],
      tier: "T3",
      zones: ["authz"],
      raised: "exports order data",
      joins: "1",
      uncertain: true,
      loweredBy: "alice",
      loweredReason: "reads public data only",
    });
  });

  it.each([
    ["no frontmatter", "# Title\n", /starts with a --- frontmatter block/],
    ["no tasks", "---\ntitle: x\ntasks: []\n---\n", /at least one task/],
    ["no title", "---\ntasks:\n  - id: 1\n    title: a\n    files: [a]\n---\n", /title/],
    ["a task without files", "---\ntitle: x\ntasks:\n  - id: 1\n    title: a\n    files: []\n---\n", /task 1 owns no files/],
    ["a duplicate id", "---\ntitle: x\ntasks:\n  - id: 1\n    title: a\n    files: [a]\n  - id: 1\n    title: b\n    files: [b]\n---\n", /duplicate task id 1/],
    ["a bad tier", "---\ntitle: x\ntasks:\n  - id: 1\n    title: a\n    files: [a]\n    tier: T9\n---\n", /task 1 tier must be T0, T1, T2 or T3/],
    ["a bad zone", "---\ntitle: x\ntasks:\n  - id: 1\n    title: a\n    files: [a]\n    zones: [login]\n---\n", /task 1 has unknown zone "login"/],
    ["a bad level", "---\ntitle: x\nlevel: yolo\ntasks:\n  - id: 1\n    title: a\n    files: [a]\n---\n", /level must be guide, confirm or autopilot/],
    ["an unknown key", "---\ntitle: x\ntasks:\n  - id: 1\n    title: a\n    files: [a]\n    owner: me\n---\n", /task 1 has unknown key "owner"/],
    ["a join to an unknown task", "---\ntitle: x\ntasks:\n  - id: 1\n    title: a\n    files: [a]\n    joins: 4\n---\n", /task 1 joins unknown task 4/],
    ["a lowering without a reason", "---\ntitle: x\ntasks:\n  - id: 1\n    title: a\n    files: [a]\n    lowered_by: bob\n---\n", /task 1 lowered_by needs lowered_reason/],
  ])("rejects %s", (_, text, message) => {
    expect(() => parseWorkOrder(text)).toThrow(message);
  });
});
