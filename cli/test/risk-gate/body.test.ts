import { describe, expect, it } from "vitest";
import { parseHumanReview } from "../../src/commands/risk-gate/body.ts";

const risk = (line: string) => `## What changed\n- x\n\n## Risk\nDoor: two-way.\nBlast radius: none.\n${line}\n\n## Auditors\n- Skipped: all (x)\n`;

describe("parseHumanReview", () => {
  it("reads none", () => {
    expect(parseHumanReview(risk("Human review: none."))).toEqual({ kind: "none" });
  });

  it("reads the zones of a required line", () => {
    const line = "Human review: required, zone:auth (src/auth/login.php), zone:input (src/form.php, src/b.php).";
    expect(parseHumanReview(risk(line))).toEqual({ kind: "required", zones: ["auth", "input"] });
  });

  it("reports a missing line", () => {
    expect(parseHumanReview(risk(""))).toEqual({ kind: "missing" });
  });

  it("ignores a Human review line outside the Risk section", () => {
    expect(parseHumanReview("## Why this approach\nHuman review: none.\n")).toEqual({ kind: "missing" });
  });

  it("treats a line that is neither form as malformed", () => {
    expect(parseHumanReview(risk("Human review: maybe."))).toEqual({ kind: "malformed", line: "Human review: maybe." });
  });

  it("treats required with no zone as malformed", () => {
    expect(parseHumanReview(risk("Human review: required."))).toMatchObject({ kind: "malformed" });
  });
});
