import { describe, expect, it } from "vitest";
import { applyCommands, renderRuleset } from "../../src/commands/github/ruleset.ts";

interface Rule {
  type: string;
  parameters?: { required_status_checks?: { context: string }[] } & Record<string, unknown>;
}
const rule = (ruleset: ReturnType<typeof renderRuleset>, type: string) => (ruleset.rules as unknown as Rule[]).find((candidate) => candidate.type === type);

describe("renderRuleset", () => {
  const ruleset = renderRuleset();

  it("targets the default branch with no bypass actors", () => {
    expect(ruleset).toMatchObject({
      name: "pipeline",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      bypass_actors: [],
    });
  });

  it("blocks force pushes and branch deletion", () => {
    expect(rule(ruleset, "non_fast_forward")).toBeDefined();
    expect(rule(ruleset, "deletion")).toBeDefined();
  });

  it("allows squash merges only, and leaves the approval count to risk-gate", () => {
    expect(rule(ruleset, "pull_request")?.parameters).toMatchObject({
      allowed_merge_methods: ["squash"],
      required_approving_review_count: 0,
      dismiss_stale_reviews_on_push: true,
      require_last_push_approval: true,
    });
  });

  it("names no team and no path based reviewers", () => {
    expect(JSON.stringify(ruleset)).not.toMatch(/required_reviewers|Team/);
  });

  it("requires the floor and risk-gate status checks", () => {
    const contexts = rule(ruleset, "required_status_checks")?.parameters?.required_status_checks?.map((check) => check.context);
    expect(contexts).toEqual(["pipeline / floor", "pipeline / risk-gate"]);
  });
});

describe("applyCommands", () => {
  const text = applyCommands({ repo: "acme/site", rulesetFile: "ruleset.json" }).join("\n");

  it("creates the ruleset from the file and looks up no team", () => {
    expect(text).toContain("gh api --method POST repos/acme/site/rulesets --input ruleset.json");
    expect(text).not.toMatch(/team/i);
  });

  it("creates each label with --force so a rerun updates it", () => {
    expect(text).toContain('gh label create "risk:critical" --repo acme/site --color');
    expect(text).toContain("--force");
    expect(text.match(/gh label create/g)).toHaveLength(14);
  });
});
