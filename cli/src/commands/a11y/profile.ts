import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml, type YamlValue } from "../scan-zones/yaml.ts";

export const DEFAULT_TARGET = "wcag22aa";

// Each conformance target adds its own axe tag to the ones below it, because axe tags a rule with the lowest level that has it.
export const TARGET_TAGS: Record<string, string[]> = {
  wcag2a: ["wcag2a"],
  wcag2aa: ["wcag2a", "wcag2aa"],
  wcag21a: ["wcag2a", "wcag21a"],
  wcag21aa: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
  wcag22aa: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
};

/**
 * What the profile's accessibility section sets
 */
export interface A11yProfile {
  target: string;
  urls: string[];
  baseUrl: string | null;
}

/**
 * Reads the accessibility section of .pipeline/profile.yml, with defaults when the file or section is absent
 */
export function readA11yProfile(dir: string): A11yProfile {
  const path = join(dir, ".pipeline/profile.yml");
  const empty: A11yProfile = { target: DEFAULT_TARGET, urls: [], baseUrl: null };
  if (!existsSync(path)) return empty;
  const profile = parseYaml(readFileSync(path, "utf8")) as { [key: string]: YamlValue } | null;
  const section = profile?.accessibility;
  if (typeof section !== "object" || section === null || Array.isArray(section)) return empty;
  const urls = Array.isArray(section.urls) ? section.urls.filter((url): url is string => typeof url === "string") : [];
  return {
    target: typeof section.target === "string" ? section.target : DEFAULT_TARGET,
    urls,
    baseUrl: typeof section.base_url === "string" ? section.base_url : null,
  };
}

/**
 * The page URLs to scan: the pages asked for first, then the profile's, each resolved against the site
 */
export function resolveUrls(baseUrl: string, wanted: string[], profile: string[]): string[] {
  const all = [...wanted, ...profile];
  const pages = all.length > 0 ? all : ["/"];
  return [...new Set(pages.map((page) => new URL(page, baseUrl).href))];
}
