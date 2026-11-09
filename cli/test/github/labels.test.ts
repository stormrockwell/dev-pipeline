import { describe, expect, it } from "vitest";
import { labelDefinitions } from "../../src/commands/github/labels.ts";
import { ZONES } from "../../src/commands/scan-zones/types.ts";

describe("labelDefinitions", () => {
  const labels = labelDefinitions();

  it("defines the four risk labels and one label per zone", () => {
    expect(labels.map((label) => label.name)).toEqual([
      "risk:low", "risk:medium", "risk:high", "risk:critical",
      ...ZONES.map((zone) => `zone:${zone}`),
    ]);
  });

  it("gives every label a six digit hex color and a description GitHub accepts", () => {
    for (const label of labels) {
      expect(label.color).toMatch(/^[0-9a-f]{6}$/);
      expect(label.description.length).toBeGreaterThan(0);
      expect(label.description.length).toBeLessThanOrEqual(100);
    }
  });

  it("gives risk labels distinct colors", () => {
    const colors = labels.filter((label) => label.name.startsWith("risk:")).map((label) => label.color);
    expect(new Set(colors).size).toBe(4);
  });

  it("states the approvals each risk label needs", () => {
    const text = Object.fromEntries(labels.map((label) => [label.name, label.description]));
    expect(text["risk:high"]).toContain("1 peer approval");
    expect(text["risk:critical"]).toContain("2 peer approvals");
  });
});
