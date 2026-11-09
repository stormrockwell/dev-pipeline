import { describe, expect, it } from "vitest";
import { APPROVALS, higherRisk, isCritical, riskForTier, riskFromLabels } from "../../src/commands/risk-gate/risk.ts";

describe("riskForTier", () => {
  it("maps each tier to the label that STRATEGY names", () => {
    expect(riskForTier("T0", false)).toBe("low");
    expect(riskForTier("T1", false)).toBe("low");
    expect(riskForTier("T2", false)).toBe("medium");
    expect(riskForTier("T3", false)).toBe("high");
  });

  it("makes T3 on a designated path critical", () => {
    expect(riskForTier("T3", true)).toBe("critical");
  });

  it("ignores a designated path below T3", () => {
    expect(riskForTier("T2", true)).toBe("medium");
  });
});

describe("isCritical", () => {
  const globs = [".github/**", "**/payments/**"];

  it("needs a T3 file that matches a designated glob", () => {
    expect(isCritical([{ file: ".github/workflows/ci.yml", tier: "T3" }], globs)).toBe(true);
    expect(isCritical([{ file: "src/payments/charge.php", tier: "T3" }], globs)).toBe(true);
  });

  it("does not count a T3 file outside the designated globs", () => {
    expect(isCritical([{ file: "src/auth/login.php", tier: "T3" }], globs)).toBe(false);
  });

  it("does not count a lower tier file inside a designated glob", () => {
    expect(isCritical([{ file: ".github/README.md", tier: "T0" }], globs)).toBe(false);
  });

  it("is false with no globs", () => {
    expect(isCritical([{ file: ".github/a.yml", tier: "T3" }], [])).toBe(false);
  });
});

describe("higherRisk and riskFromLabels", () => {
  it("orders low below critical", () => {
    expect(higherRisk("medium", "high")).toBe("high");
    expect(higherRisk("critical", "low")).toBe("critical");
  });

  it("takes the highest risk label on a PR", () => {
    expect(riskFromLabels(["bug", "risk:low", "risk:high"])).toBe("high");
    expect(riskFromLabels(["bug"])).toBeNull();
  });
});

describe("APPROVALS", () => {
  it("matches the STRATEGY table", () => {
    expect(APPROVALS).toEqual({
      low: { total: 1, zone: 0 },
      medium: { total: 1, zone: 0 },
      high: { total: 1, zone: 1 },
      critical: { total: 2, zone: 1 },
    });
  });
});
