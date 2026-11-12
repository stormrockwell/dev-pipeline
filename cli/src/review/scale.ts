import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml, type YamlValue } from "../commands/scan-zones/yaml.ts";

// Decision 12: a repo that declares no scale is designed for about this many items per entity.
export const DEFAULT_SCALE = 500;

export interface Scale {
  fallback: number;
  entities: Record<string, number>;
  // Whether the profile has a scale key, so a package can say the number is an assumption.
  declared: boolean;
}

/**
 * Whether a YAML value is a positive whole number
 */
function ceiling(value: YamlValue | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * The scale ceilings in the repo's profile, or the assumed default when it declares none
 *
 * An unreadable profile counts as no profile, because a review should not stop on a YAML typo.
 */
export function readScale(dir: string): Scale {
  const path = join(dir, ".pipeline/profile.yml");
  const none: Scale = { fallback: DEFAULT_SCALE, entities: {}, declared: false };
  if (!existsSync(path)) return none;
  let scale: YamlValue | undefined;
  try {
    scale = (parseYaml(readFileSync(path, "utf8")) as { [key: string]: YamlValue } | null)?.scale;
  } catch {
    return none;
  }
  if (typeof scale !== "object" || scale === null || Array.isArray(scale)) return none;
  const { default: fallback, ...rest } = scale;
  return {
    fallback: ceiling(fallback) ? fallback : DEFAULT_SCALE,
    entities: Object.fromEntries(Object.entries(rest).filter((entry): entry is [string, number] => ceiling(entry[1]))),
    declared: true,
  };
}

/**
 * The scale as one line for a review package, saying whether the profile or an assumption set it
 */
export function describeScale(scale: Scale): string {
  if (!scale.declared) return `about ${scale.fallback}, assumed because the profile declares none`;
  const entities = Object.entries(scale.entities).map(([name, count]) => `${name} ${count}`);
  return [`about ${scale.fallback} by default`, ...entities].join(", ");
}
