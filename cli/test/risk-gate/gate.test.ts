import { describe, expect, it } from "vitest";
import { evaluate, type GateInput } from "../../src/commands/risk-gate/gate.ts";
import type { Review } from "../../src/commands/risk-gate/reviews.ts";

const HEAD = "bbbb";

function body(humanReview: string): string {
  return `## What changed\n- x\n\n## Risk\nDoor: two-way.\nBlast radius: none.\n${humanReview}\n\n## Auditors\n- Skipped: all (x)\n`;
}

const approve = (login: string): Review => ({ user: { login, type: "User" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-01-01T00:00:00Z" });

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    tier: "T2",
    scanZones: [],
    files: [{ file: "src/a.php", tier: "T2" }],
    critical: [".github/**"],
    body: body("Human review: none."),
    labels: [],
    approvals: null,
    ...overrides,
  };
}

const zonePr = (overrides: Partial<GateInput> = {}) =>
  input({
    tier: "T3",
    scanZones: ["auth"],
    files: [{ file: "src/auth/login.php", tier: "T3" }],
    body: body("Human review: required, zone:auth (src/auth/login.php)."),
    ...overrides,
  });

describe("labels", () => {
  it.each([
    ["T0", "risk:low"],
    ["T1", "risk:low"],
    ["T2", "risk:medium"],
  ] as const)("labels %s as %s", (tier, label) => {
    const result = evaluate(input({ tier, files: [{ file: "a", tier }] }));
    expect(result.labels.add).toEqual([label]);
    expect(result.ok).toBe(true);
  });

  it("labels T3 with its zones as risk:high", () => {
    const result = evaluate(zonePr());
    expect(result.risk).toBe("high");
    expect(result.labels.add).toEqual(["risk:high", "zone:auth"]);
  });

  it("labels T3 on a designated path as risk:critical", () => {
    const result = evaluate(
      zonePr({ scanZones: ["guardrails"], files: [{ file: ".github/workflows/ci.yml", tier: "T3" }], body: body("Human review: required, zone:guardrails (.github/workflows/ci.yml).") }),
    );
    expect(result.risk).toBe("critical");
    expect(result.labels.add).toEqual(["risk:critical", "zone:guardrails"]);
  });

  it("adds nothing that the PR already carries", () => {
    const result = evaluate(zonePr({ labels: ["risk:high", "zone:auth"] }));
    expect(result.labels).toEqual({ add: [], remove: [] });
  });

  it("removes a lower risk label the PR carries", () => {
    const result = evaluate(zonePr({ labels: ["risk:low"] }));
    expect(result.labels).toEqual({ add: ["risk:high", "zone:auth"], remove: ["risk:low"] });
  });

  it("never lowers a risk label that a human raised", () => {
    const result = evaluate(input({ labels: ["risk:critical"] }));
    expect(result.risk).toBe("critical");
    expect(result.labels).toEqual({ add: [], remove: [] });
  });

  it("keeps a zone label the scan no longer finds", () => {
    const result = evaluate(input({ labels: ["zone:privacy"] }));
    expect(result.zones).toEqual(["privacy"]);
    expect(result.risk).toBe("high");
    expect(result.labels.remove).toEqual([]);
  });

  it("sorts zone labels", () => {
    const result = evaluate(zonePr({ scanZones: ["input", "auth"], body: body("Human review: required, zone:auth (a), zone:input (b).") }));
    expect(result.labels.add).toEqual(["risk:high", "zone:auth", "zone:input"]);
  });
});

describe("Human review line against the scan", () => {
  it("passes none when the scan finds no zones", () => {
    expect(evaluate(input())).toMatchObject({ ok: true, failures: [], warnings: [] });
  });

  it("passes when the zones match", () => {
    expect(evaluate(zonePr())).toMatchObject({ ok: true, failures: [], warnings: [] });
  });

  it("fails when the scan finds zones and the body says none", () => {
    const result = evaluate(zonePr({ body: body("Human review: none.") }));
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([expect.stringContaining("none")]);
    expect(result.failures[0]).toContain("zone:auth");
  });

  it("fails when the body names only some of the zones the scan found", () => {
    const result = evaluate(zonePr({ scanZones: ["auth", "input"], body: body("Human review: required, zone:auth (a).") }));
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([expect.stringContaining("zone:input")]);
  });

  it("warns, and does not fail, when the body names an extra zone", () => {
    const result = evaluate(zonePr({ body: body("Human review: required, zone:auth (a), zone:privacy (b).") }));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([expect.stringContaining("zone:privacy")]);
  });

  it("treats zones that only the body names as raised, so they get labels", () => {
    const result = evaluate(input({ body: body("Human review: required, zone:privacy (src/log.php).") }));
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.risk).toBe("high");
    expect(result.labels.add).toEqual(["risk:high", "zone:privacy"]);
  });

  it("fails when the line is missing and the scan found zones", () => {
    const result = evaluate(zonePr({ body: "## Risk\nDoor: two-way.\n" }));
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain("Human review");
  });

  it("warns when the line is missing and the scan is clean", () => {
    const result = evaluate(input({ body: "## Risk\nDoor: two-way.\n" }));
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });

  it("fails on a malformed line when the scan found zones", () => {
    const result = evaluate(zonePr({ body: body("Human review: maybe.") }));
    expect(result.ok).toBe(false);
  });
});

describe("approvals", () => {
  const approvalInput = (reviews: Review[], extra: Record<string, unknown> = {}) => ({
    reviews,
    headSha: HEAD,
    author: "dev",
    zoneApprovers: ["lead"],
    trusted: [],
    ...extra,
  });

  it("skips the check when no review data is given", () => {
    expect(evaluate(zonePr()).approvals).toBeNull();
  });

  it("fails a risk:medium PR with no approval", () => {
    const result = evaluate(input({ approvals: approvalInput([]) }));
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([expect.stringContaining("1 approval")]);
  });

  it("passes a risk:medium PR with one approval from anyone else", () => {
    expect(evaluate(input({ approvals: approvalInput([approve("peer")]) })).ok).toBe(true);
  });

  it("fails a zone PR approved only by a non zone approver", () => {
    const result = evaluate(zonePr({ approvals: approvalInput([approve("peer")]) }));
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([expect.stringContaining("zone approver")]);
  });

  it("passes a zone PR approved by a zone approver", () => {
    expect(evaluate(zonePr({ approvals: approvalInput([approve("lead")]) })).ok).toBe(true);
  });

  it("fails a critical PR with one approval, even from a zone approver", () => {
    const critical = {
      scanZones: ["guardrails"],
      files: [{ file: ".github/a.yml", tier: "T3" as const }],
      body: body("Human review: required, zone:guardrails (.github/a.yml)."),
    };
    const one = evaluate(zonePr({ ...critical, approvals: approvalInput([approve("lead")]) }));
    expect(one.ok).toBe(false);
    expect(one.failures).toEqual([expect.stringContaining("2 approvals")]);
    expect(evaluate(zonePr({ ...critical, approvals: approvalInput([approve("lead"), approve("peer")]) })).ok).toBe(true);
  });

  it("fails a critical PR approved twice by non zone approvers", () => {
    const result = evaluate(
      zonePr({ labels: ["risk:critical"], approvals: approvalInput([approve("peer"), approve("other")]) }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([expect.stringContaining("zone approver")]);
  });

  it("fails a zone PR when no zone approvers are configured", () => {
    const result = evaluate(zonePr({ approvals: approvalInput([approve("lead")], { zoneApprovers: [] }) }));
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain("no zone approvers");
  });

  it("counts a trusted author's attestation as one approval but not a zone approval", () => {
    expect(evaluate(input({ approvals: approvalInput([], { trusted: ["dev"] }) })).ok).toBe(true);
    expect(evaluate(zonePr({ approvals: approvalInput([], { trusted: ["dev"] }) })).ok).toBe(false);
  });

  it("uses the higher of the computed risk and the label to set the requirement", () => {
    const result = evaluate(input({ labels: ["risk:high"], approvals: approvalInput([approve("peer")]) }));
    expect(result.risk).toBe("high");
    expect(result.ok).toBe(false);
  });

  it("reports the counts", () => {
    const result = evaluate(zonePr({ approvals: approvalInput([approve("lead")]) }));
    expect(result.approvals).toEqual({ required: 1, zoneRequired: 1, have: 1, zoneHave: 1 });
  });
});
