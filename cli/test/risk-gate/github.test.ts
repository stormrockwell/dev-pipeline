import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countApprovals } from "../../src/commands/risk-gate/reviews.ts";
import { labelEditArgs, parseEvent, parseReviews } from "../../src/commands/risk-gate/github.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseEvent", () => {
  it("reads the fields the gate needs", () => {
    expect(parseEvent(JSON.parse(fixture("pull_request.json")))).toEqual({
      repo: "acme/site",
      number: 42,
      title: "feat(auth): add login throttle",
      body: "## Risk\nHuman review: required, zone:authz (src/auth/throttle.php).\n",
      author: "dev",
      headSha: "bbbb",
      labels: ["risk:low", "bug"],
    });
  });

  it("reads a null body as empty", () => {
    const payload = JSON.parse(fixture("pull_request.json"));
    payload.pull_request.body = null;
    expect(parseEvent(payload).body).toBe("");
  });

  it("rejects a payload that is not a pull request event", () => {
    expect(() => parseEvent({ ref: "refs/heads/main" })).toThrow(/pull request event/);
    expect(() => parseEvent(null)).toThrow(/pull request event/);
  });
});

describe("parseReviews", () => {
  it("reads a JSON array", () => {
    const reviews = parseReviews(fixture("reviews.json"));
    expect(countApprovals({ reviews, headSha: "bbbb", author: "dev" }).total).toBe(1);
  });

  it("reads one JSON object per line, as gh api --jq prints", () => {
    const lines = JSON.parse(fixture("reviews.json")).map((review: unknown) => JSON.stringify(review)).join("\n");
    expect(parseReviews(lines)).toHaveLength(2);
  });

  it("reads empty output as no reviews", () => {
    expect(parseReviews("\n")).toEqual([]);
  });
});

describe("labelEditArgs", () => {
  it("builds a gh pr edit call", () => {
    expect(labelEditArgs("acme/site", 42, { add: ["risk:high", "zone:auth"], remove: ["risk:low"] })).toEqual([
      "pr", "edit", "42", "--repo", "acme/site", "--add-label", "risk:high,zone:auth", "--remove-label", "risk:low",
    ]);
  });

  it("returns null when nothing changes", () => {
    expect(labelEditArgs("acme/site", 42, { add: [], remove: [] })).toBeNull();
  });
});
