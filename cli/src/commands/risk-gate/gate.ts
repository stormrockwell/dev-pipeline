import type { Tier } from "../classify/tier.ts";
import { ZONES } from "../scan-zones/types.ts";
import { parseHumanReview } from "./body.ts";
import { countApprovals, type ApprovalInput } from "./reviews.ts";
import {
  APPROVALS,
  RISKS,
  ZONE_PREFIX,
  higherRisk,
  isCritical,
  riskForTier,
  riskFromLabels,
  riskLabel,
  zoneLabel,
  type Risk,
} from "./risk.ts";

export interface GateInput {
  tier: Tier;
  scanZones: string[];
  files: { file: string; tier: Tier }[];
  /** Globs of designated paths from sensitive.yml. */
  critical: string[];
  body: string;
  /** Labels the PR carries now. */
  labels: string[];
  /** Null when no review data was given, as in a local run. */
  approvals: ApprovalInput | null;
}

export interface GateResult {
  ok: boolean;
  tier: Tier;
  risk: Risk;
  zones: string[];
  labels: { add: string[]; remove: string[] };
  approvals: { required: number; have: number } | null;
  failures: string[];
  warnings: string[];
}

const zoneNames = (zones: string[]) => zones.map(zoneLabel).join(", ");
const plural = (count: number) => `${count} approval${count === 1 ? "" : "s"}`;

function unique(items: string[]): string[] {
  return [...new Set(items)].sort();
}

/** Compares the body's Human review line with the zones the scan found. */
function compareBody(body: string, scanZones: string[]): { failures: string[]; warnings: string[]; raised: string[] } {
  const review = parseHumanReview(body);
  const failures: string[] = [];
  const warnings: string[] = [];
  let raised: string[] = [];

  if (review.kind === "required") {
    const named = review.zones.filter((zone) => (ZONES as readonly string[]).includes(zone));
    const missing = scanZones.filter((zone) => !named.includes(zone));
    const extra = named.filter((zone) => !scanZones.includes(zone));
    if (missing.length > 0) failures.push(`The Human review line omits ${zoneNames(missing)}, which the scan found. Name every zone the scan found.`);
    if (extra.length > 0) warnings.push(`The Human review line names ${zoneNames(extra)}, which the scan did not find. The label is added because a human may raise a zone.`);
    raised = extra;
  } else if (scanZones.length > 0) {
    const found = zoneNames(scanZones);
    if (review.kind === "none") failures.push(`The Human review line says none, but the scan found ${found}.`);
    else if (review.kind === "missing") failures.push(`The Risk section has no Human review line, and the scan found ${found}.`);
    else failures.push(`The Human review line is malformed (${review.line}), and the scan found ${found}.`);
  } else if (review.kind !== "none") {
    warnings.push(review.kind === "missing" ? "The Risk section has no Human review line." : `The Human review line is malformed (${review.line}).`);
  }
  return { failures, warnings, raised };
}

function checkApprovals(risk: Risk, approvals: ApprovalInput): { failures: string[]; counts: NonNullable<GateResult["approvals"]> } {
  const required = APPROVALS[risk];
  const have = countApprovals(approvals).total;
  const failures = have < required ? [`${riskLabel(risk)} needs ${plural(required)} from people other than the author, found ${have}.`] : [];
  return { failures, counts: { required, have } };
}

/**
 * Recomputes risk from the diff and takes the higher of that and the PR's labels, so removing a label
 * never lowers the requirement. Labels only ever go up, because lowering is a peer reviewer's action.
 */
export function evaluate(input: GateInput): GateResult {
  const body = compareBody(input.body, input.scanZones);
  const labelZones = input.labels.filter((label) => label.startsWith(ZONE_PREFIX)).map((label) => label.slice(ZONE_PREFIX.length));
  const zones = unique([...input.scanZones, ...body.raised, ...labelZones]);

  const computed = riskForTier(input.tier, isCritical(input.files, input.critical));
  let risk = higherRisk(computed, riskFromLabels(input.labels) ?? "low");
  if (zones.length > 0) risk = higherRisk(risk, "high");

  const wanted = [riskLabel(risk), ...zones.map(zoneLabel)];
  const add = wanted.filter((label) => !input.labels.includes(label));
  const remove = RISKS.map(riskLabel).filter((label) => label !== riskLabel(risk) && input.labels.includes(label));

  const failures = [...body.failures];
  let counts: GateResult["approvals"] = null;
  if (input.approvals) {
    const checked = checkApprovals(risk, input.approvals);
    failures.push(...checked.failures);
    counts = checked.counts;
  }

  return { ok: failures.length === 0, tier: input.tier, risk, zones, labels: { add, remove }, approvals: counts, failures, warnings: body.warnings };
}
