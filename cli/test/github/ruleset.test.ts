import { describe, expect, it } from "vitest";
import { applyCommands, renderRuleset } from "../../src/commands/github/ruleset.ts";
import { parseConfig } from "../../src/commands/scan-zones/config.ts";

const sample = parseConfig(`
paths:
  - "**/auth/**"
  - "composer.{json,lock}"
  - path: "**/billing/**"
    zone: privacy
critical:
  - "**/auth/**"
`);

type Rule = { type: string; parameters?: Record<string, any> };
const rule = (ruleset: ReturnType<typeof renderRuleset>, type: string) => (ruleset.rules as Rule[]).find((candidate) => candidate.type === type);

describe("renderRuleset", () => {
  const ruleset = renderRuleset(sample, { teamId: 123 });

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

  it("requires the floor and risk-gate status checks", () => {
    const contexts = rule(ruleset, "required_status_checks")?.parameters?.required_status_checks.map((check: { context: string }) => check.context);
    expect(contexts).toEqual(["pipeline / floor", "pipeline / risk-gate"]);
  });

  it("requires the zone team for every sensitive path, and two approvals on designated paths", () => {
    const reviewers = rule(ruleset, "pull_request")?.parameters?.required_reviewers;
    expect(reviewers).toHaveLength(2);
    expect(reviewers[0]).toMatchObject({ minimum_approvals: 1, reviewer: { id: 123, type: "Team" } });
    expect(reviewers[0].file_patterns).toEqual([
      "**/auth/**", "composer.json", "**/composer.json", "composer.lock", "**/composer.lock", "**/billing/**",
    ]);
    expect(reviewers[1]).toMatchObject({ minimum_approvals: 2, file_patterns: ["**/auth/**"], reviewer: { id: 123, type: "Team" } });
  });

  it("omits the designated path entry when the file has none", () => {
    const none = renderRuleset(parseConfig("paths:\n  - '**/auth/**'\ncritical:\n"), { teamId: 1 });
    expect(rule(none, "pull_request")?.parameters?.required_reviewers).toHaveLength(1);
  });

  it("uses the default designated paths when sensitive.yml omits critical", () => {
    const defaults = renderRuleset(parseConfig("paths:\n  - '**/auth/**'\n"), { teamId: 1 });
    expect(rule(defaults, "pull_request")?.parameters?.required_reviewers[1].file_patterns).toEqual([
      ".github/**", "**/.github/**", ".pipeline/**", "**/.pipeline/**", ".claude/**", "**/.claude/**",
    ]);
  });

  it("drops the reviewer rule when no path is sensitive", () => {
    const empty = renderRuleset(parseConfig("signals:\n  php:\n    - pattern: 'x'\n      zone: input\ncritical:\n"), { teamId: 1 });
    expect(rule(empty, "pull_request")?.parameters).not.toHaveProperty("required_reviewers");
  });
});

describe("applyCommands", () => {
  const text = applyCommands({ repo: "acme/site", team: "zone-approvers", rulesetFile: "ruleset.json" }).join("\n");

  it("looks up the team, fills in its id and creates the ruleset", () => {
    expect(text).toContain("gh api orgs/acme/teams/zone-approvers --jq .id");
    expect(text).toContain("--argjson team");
    expect(text).toContain("gh api --method POST repos/acme/site/rulesets --input -");
  });

  it("creates each label with --force so a rerun updates it", () => {
    expect(text).toContain('gh label create "risk:critical" --repo acme/site --color');
    expect(text).toContain("--force");
    expect(text.match(/gh label create/g)).toHaveLength(14);
  });
});
