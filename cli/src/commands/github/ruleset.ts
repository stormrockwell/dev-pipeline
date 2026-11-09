import { labelDefinitions } from "./labels.ts";

/**
 * Names of the required status checks. A GitHub check is named `<caller job> / <reusable job>`, so
 * the caller workflow in templates/github/pipeline.yml must call the reusable workflow from a job
 * with the id `pipeline`.
 */
export const STATUS_CHECKS = ["pipeline / floor", "pipeline / risk-gate"];

type Json = Record<string, unknown>;

/**
 * Renders the body for `POST /repos/{owner}/{repo}/rulesets`. A ruleset cannot key approvals on a
 * label, so it requires the risk-gate check and leaves the peer approval count to that check.
 */
export function renderRuleset(): Json & { rules: Json[] } {
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
          // Zero lets a low risk PR reach zero approvals once that tier earns it, and risk-gate sets the count meanwhile.
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: true,
          required_review_thread_resolution: false,
          allowed_merge_methods: ["squash"],
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
  rulesetFile: string;
}

const quote = (text: string) => `"${text.replace(/(["\\$`])/g, "\\$1")}"`;

// The commands a human runs to install the layer. The CLI prints them and never runs them.
export function applyCommands(options: ApplyOptions): string[] {
  const labels = labelDefinitions().map(
    (label) => `gh label create ${quote(label.name)} --repo ${options.repo} --color ${label.color} --description ${quote(label.description)} --force`,
  );
  return [
    "# Create or update the labels.",
    ...labels,
    "",
    "# Create the ruleset.",
    `gh api --method POST repos/${options.repo}/rulesets --input ${options.rulesetFile}`,
  ];
}
