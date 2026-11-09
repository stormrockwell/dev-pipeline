import type { Zone } from "../scan-zones/types.ts";
import type { AnswerType } from "./questions.ts";

// What the profile and sensitive.yml record, whether it came from detection or from a new scaffold.
export interface Facts {
  type: AnswerType;
  name?: string;
  distributed?: boolean;
  public?: boolean;
  php?: string;
  node?: string;
  framework?: string;
  git: { defaultBranch: string; commits: "conventional" | "free" };
  peerReview?: boolean;
  tests: { unit?: string; integration?: string; js?: string; e2e?: string };
  // Whether a suite already exists, which decides if TDD is the default or a question for the work order.
  hasSuite: boolean;
  urls: string[];
  packs: string[];
  extraPaths: { glob: string; zone: Zone }[];
}

const SITES = ["node-site", "wordpress-theme"];
const PHP_TYPES = ["wordpress-plugin", "wordpress-theme"];

// Words that a YAML reader would turn into another type if they were left bare.
const RESERVED = /^(true|false|yes|no|on|off|null|~)$/i;

// Quotes a value unless it is plainly a string, so "8.0" stays text and "yes" stays text.
function scalar(value: string): string {
  const plain = /^[A-Za-z][A-Za-z0-9 _./@-]*$/.test(value) && !RESERVED.test(value) && !/\s$/.test(value);
  return plain ? value : JSON.stringify(value);
}

function list(values: string[]): string {
  return `[${values.map((value) => (/^[A-Za-z0-9_./-]+$/.test(value) && !RESERVED.test(value) ? value : JSON.stringify(value))).join(", ")}]`;
}

function line(key: string, value: string | boolean | undefined, indent = "  "): string[] {
  if (value === undefined) return [];
  return [`${indent}${key}: ${typeof value === "boolean" ? String(value) : scalar(value)}`];
}

export function packsFor(type: AnswerType, languages: string[], hasNodeFramework: boolean): string[] {
  if (PHP_TYPES.includes(type)) return hasNodeFramework ? ["wordpress", "node"] : ["wordpress"];
  if (type === "node-site" || type === "node-library") return ["node"];
  const packs = [];
  if (languages.includes("php")) packs.push("wordpress");
  if (languages.some((language) => language === "javascript" || language === "typescript")) packs.push("node");
  return packs.length > 0 ? packs : ["wordpress", "node"];
}

export function renderProfile(facts: Facts): string {
  const phpProject = PHP_TYPES.includes(facts.type) || facts.php !== undefined;
  const floor = ["lint", "sast", "secrets", "deps", ...(SITES.includes(facts.type) ? ["a11y"] : []), "human-review-zones"];

  const lines = [
    "# Written by pipeline init. Init never overwrites this file, so edit it freely.",
    "project:",
    ...line("type", facts.type),
    ...line("name", facts.name),
    ...line("distributed", facts.distributed),
    ...line("public", facts.public),
    ...line("framework", facts.framework),
    ...line("php", facts.php),
    ...line("node", facts.node),
    "git:",
    ...line("default_branch", facts.git.defaultBranch),
    ...line("strategy", "trunk"),
    ...line("merge", "squash"),
    ...line("commits", facts.git.commits),
    ...line("peer_review", facts.peerReview),
    "tests:",
    ...(phpProject ? [...line("unit", facts.tests.unit ?? "none"), ...line("integration", facts.tests.integration ?? "none")] : []),
    ...line("js", facts.tests.js ?? "none"),
    ...line("e2e", facts.tests.e2e ?? "none"),
    ...(SITES.includes(facts.type) ? ["accessibility:", ...line("target", "wcag22aa"), `  urls: ${list(facts.urls)}`] : []),
    "policy:",
    `  floor: ${list(floor)}`,
    ...line("tdd", facts.hasSuite ? "always" : "ask"),
  ];
  return `${lines.join("\n")}\n`;
}

export function renderSensitive(facts: Facts): string {
  const lines = [
    "# Zone rules for the pipeline. Team leads own this file, and docs/zones.md in stormrockwell/dev-pipeline holds the schema.",
    "# The packs already cover auth, migrations, manifests, workflows and environment files.",
    `packs: ${list(facts.packs)}`,
  ];
  if (facts.extraPaths.length > 0) {
    lines.push("", "paths:");
    for (const rule of facts.extraPaths) lines.push(`  - path: ${JSON.stringify(rule.glob)}`, `    zone: ${rule.zone}`);
  }
  return `${lines.join("\n")}\n`;
}
