import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { classifyInputs } from "../classify/tier.ts";
import { collectRange } from "../scan-zones/collect.ts";
import { loadConfig } from "../scan-zones/config.ts";
import { buildReport } from "../scan-zones/report.ts";
import { scanFile } from "../scan-zones/scan.ts";
import { evaluate, type GateResult } from "./gate.ts";
import { applyLabels, fetchReviews, parseEvent, parseReviews, type PullRequestEvent } from "./github.ts";
import type { ApprovalInput } from "./reviews.ts";
import { riskLabel } from "./risk.ts";

const usage = `Usage: pipeline risk-gate --range <from>..<to> [options]

Recomputes a PR's risk from its diff, the way docs/STRATEGY.md describes the risk-gate check.

  1. Maps the highest file tier to a label: T0 and T1 risk:low, T2 risk:medium, T3 risk:high, and T3 on
     a designated path (the \`critical\` globs of .pipeline/sensitive.yml) risk:critical.
  2. Adds a zone:<name> label for each zone the scan found.
  3. Fails when the PR body's Human review line disagrees with the scan. A body that says none while
     the scan found zones, or that omits a found zone, fails. A body that names an extra zone warns.
  4. With --event, fails when the PR lacks the approvals its risk needs.

The result never lowers a label the PR already carries.

Input:
  --range <from>..<to>      The change to classify. Use the merge base as <from>.
  --body-file <file>        PR body. Defaults to the body in --event.
  --event <file>            A pull_request event payload, as GITHUB_EVENT_PATH names it. Turns on the
                            approval check, which reads reviews with "gh api" and the ambient GH_TOKEN.
  --reviews <file>          Read reviews from this file (a JSON array) instead of calling "gh api".
  --zone-approvers <list>   Comma separated logins of zone approvers. Defaults to $PIPELINE_ZONE_APPROVERS.
  --trusted <list>          Comma separated logins whose own attestation counts as one approval.
  --labels <list>           Labels the PR carries, for a run without --event.
  --path <dir>              Repo to diff. Defaults to the current directory.

Output:
  --apply                   Run "gh pr edit" to add and remove labels. Needs --event. A failure to edit
                            is a warning, because a fork's token is read only.
  --json                    Print the result as JSON.

Exit codes: 0 when the gate passes, 1 when it fails, 2 for bad usage or an invalid sensitive.yml.`;

function fail(message: string): number {
  console.error(`pipeline risk-gate: ${message}`);
  return 2;
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function formatText(result: GateResult): string {
  const out = [`Risk: ${riskLabel(result.risk)} (${result.tier})`, `Zones: ${result.zones.length > 0 ? result.zones.join(", ") : "none"}`];
  const edits = [`add ${result.labels.add.join(", ") || "nothing"}`, `remove ${result.labels.remove.join(", ") || "nothing"}`];
  out.push(`Labels: ${edits.join("; ")}`);
  if (result.approvals) {
    const { have, required, zoneHave, zoneRequired } = result.approvals;
    out.push(`Approvals: ${have} of ${required} required, ${zoneHave} of ${zoneRequired} from zone approvers`);
  } else {
    out.push("Approvals: not checked, no --event given");
  }
  for (const failure of result.failures) out.push(`FAIL ${failure}`);
  for (const warning of result.warnings) out.push(`WARN ${warning}`);
  return out.join("\n");
}

async function run(argv: string[]): Promise<number> {
  let values;
  try {
    values = parseArgs({
      args: argv,
      options: {
        range: { type: "string" },
        "body-file": { type: "string" },
        event: { type: "string" },
        reviews: { type: "string" },
        "zone-approvers": { type: "string" },
        trusted: { type: "string" },
        labels: { type: "string" },
        path: { type: "string" },
        apply: { type: "boolean" },
        json: { type: "boolean" },
      },
      allowPositionals: false,
    }).values;
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline risk-gate --help".`);
  }
  if (values.range === undefined) return fail("give --range <from>..<to>.");
  if (values.apply && values.event === undefined) return fail("--apply needs --event, which names the PR to edit.");
  if (values.event === undefined && values["body-file"] === undefined) return fail("give --body-file or --event.");

  let event: PullRequestEvent | null = null;
  let body = "";
  let reviewText: string | null = null;
  try {
    if (values.event !== undefined) event = parseEvent(JSON.parse(readFileSync(values.event, "utf8")));
    body = values["body-file"] !== undefined ? readFileSync(values["body-file"], "utf8") : event!.body;
    if (values.reviews !== undefined) reviewText = readFileSync(values.reviews, "utf8");
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const collected = collectRange(resolve(values.path ?? process.cwd()), values.range);
  if (!collected.ok) return fail(collected.error);
  let classification;
  let scanZones: string[];
  let critical: string[];
  try {
    const config = loadConfig(collected.collected.root);
    classification = classifyInputs(config, collected.collected.inputs);
    const report = buildReport("range", config, collected.collected.inputs.map((input) => scanFile(config, input)));
    scanZones = Object.keys(report.summary.zones).sort();
    critical = config.critical;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  let approvals: ApprovalInput | null = null;
  if (event) {
    try {
      approvals = {
        reviews: reviewText !== null ? parseReviews(reviewText) : fetchReviews(event.repo, event.number),
        headSha: event.headSha,
        author: event.author,
        zoneApprovers: list(values["zone-approvers"] ?? process.env.PIPELINE_ZONE_APPROVERS),
        trusted: list(values.trusted),
      };
    } catch (error) {
      // The gate closes when it cannot read the reviews, because a pass without them proves nothing.
      console.error(`pipeline risk-gate: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  const result = evaluate({
    tier: classification.tier,
    scanZones,
    files: classification.files,
    critical,
    body,
    labels: event ? event.labels : list(values.labels),
    approvals,
  });

  console.log(values.json ? JSON.stringify(result, null, 2) : formatText(result));

  if (values.apply && event) {
    const applied = applyLabels(event.repo, event.number, result.labels);
    if (!applied.ok) console.error(`pipeline risk-gate: could not edit labels, ${applied.error}`);
  }
  return result.ok ? 0 : 1;
}

const command: Command = {
  name: "risk-gate",
  summary: "Recompute a PR's risk labels and check its approvals.",
  usage,
  run,
};

export default command;
