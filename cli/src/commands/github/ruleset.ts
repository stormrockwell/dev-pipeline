import type { ZoneConfig } from "../scan-zones/types.ts";
import { labelDefinitions } from "./labels.ts";
import { rulesetPatterns } from "./patterns.ts";

/**
 * Names of the required status checks. A GitHub check is named `<caller job> / <reusable job>`, so
 * the caller workflow in templates/github/pipeline.yml must call the reusable workflow from a job
 * with the id `pipeline`.
 */
export const STATUS_CHECKS = ["pipeline / floor", "pipeline / risk-gate"];

export interface RulesetOptions {
  /** The id of the zone approvers team. The printed commands fill it in from the team slug. */
  teamId: number;
}

type Json = Record<string, unknown>;

/** Renders the body for `POST /repos/{owner}/{repo}/rulesets` from a repo's zone rules. */
export function renderRuleset(config: ZoneConfig, options: RulesetOptions): Json & { rules: Json[] } {
  const reviewer = { id: options.teamId, type: "Team" };
  const sensitive = rulesetPatterns(config.paths.map((rule) => rule.glob));
  const designated = rulesetPatterns(config.critical);
  const requiredReviewers = [
    ...(sensitive.length > 0 ? [{ file_patterns: sensitive, minimum_approvals: 1, reviewer }] : []),
    ...(designated.length > 0 && sensitive.length > 0 ? [{ file_patterns: designated, minimum_approvals: 2, reviewer }] : []),
  ];

  return {
    name: "pipeline",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    bypass_actors: [],
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          // The count stays at zero because risk-gate sets the number of approvals per PR.
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: true,
          required_review_thread_resolution: false,
          allowed_merge_methods: ["squash"],
          ...(requiredReviewers.length > 0 ? { required_reviewers: requiredReviewers } : {}),
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: STATUS_CHECKS.map((context) => ({ context })),
        },
      },
    ],
  };
}

export interface ApplyOptions {
  repo: string;
  team: string;
  rulesetFile: string;
}

const quote = (text: string) => `"${text.replace(/(["\\$`])/g, "\\$1")}"`;

/** The commands a human runs to install the layer. The CLI prints them and never runs them. */
export function applyCommands(options: ApplyOptions): string[] {
  const [owner] = options.repo.split("/");
  const labels = labelDefinitions().map(
    (label) => `gh label create ${quote(label.name)} --repo ${options.repo} --color ${label.color} --description ${quote(label.description)} --force`,
  );
  return [
    "# Create or update the labels.",
    ...labels,
    "",
    "# Create the ruleset. The zone approvers team must exist in the organization.",
    `TEAM_ID=$(gh api orgs/${owner}/teams/${options.team} --jq .id)`,
    `jq --argjson team "$TEAM_ID" '(.rules[] | select(.type == "pull_request") | .parameters.required_reviewers[]?.reviewer.id) = $team' ${options.rulesetFile} \\`,
    `  | gh api --method POST repos/${options.repo}/rulesets --input -`,
  ];
}
