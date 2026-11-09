import { matchesGlob } from "../scan-zones/glob.ts";
import type { Tier } from "../classify/tier.ts";

export type Risk = "low" | "medium" | "high" | "critical";

// Ordered from least to most risk, so an index compares two risks.
export const RISKS: readonly Risk[] = ["low", "medium", "high", "critical"];

// Peer approvals each risk needs, from the "Labels and merge rules" table in docs/STRATEGY.md.
export const APPROVALS: Record<Risk, number> = { low: 1, medium: 1, high: 1, critical: 2 };

export const RISK_PREFIX = "risk:";
export const ZONE_PREFIX = "zone:";

export function riskLabel(risk: Risk): string {
  return `${RISK_PREFIX}${risk}`;
}

export function zoneLabel(zone: string): string {
  return `${ZONE_PREFIX}${zone}`;
}

export function riskForTier(tier: Tier, critical: boolean): Risk {
  if (tier === "T3") return critical ? "critical" : "high";
  return tier === "T2" ? "medium" : "low";
}

export function higherRisk(a: Risk, b: Risk): Risk {
  return RISKS.indexOf(a) >= RISKS.indexOf(b) ? a : b;
}

// The highest risk label on a PR, or null when it has none.
export function riskFromLabels(labels: string[]): Risk | null {
  let found: Risk | null = null;
  for (const label of labels) {
    const risk = RISKS.find((candidate) => riskLabel(candidate) === label);
    if (risk) found = found ? higherRisk(found, risk) : risk;
  }
  return found;
}

// A change is critical when a T3 file sits on a designated path, because the strategy gates only T3 that way.
export function isCritical(files: { file: string; tier: Tier }[], globs: string[]): boolean {
  return files.some((file) => file.tier === "T3" && globs.some((glob) => matchesGlob(glob, file.file)));
}
