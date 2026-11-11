import { basename, extname } from "node:path";
import type { Reacher } from "./reach.ts";
import { scanFile } from "../scan-zones/scan.ts";
import type { FileInput, Zone, ZoneConfig } from "../scan-zones/types.ts";

export type Tier = "T0" | "T1" | "T2" | "T3";

export const TIER_NAMES: Record<Tier, string> = {
  T0: "Docs",
  T1: "Presentation",
  T2: "Logic",
  T3: "Sensitive",
};

const ORDER: Tier[] = ["T0", "T1", "T2", "T3"];

export type Rule = "empty" | "file-type" | "template" | "path" | "zone" | "removed-signal" | "reach";

export interface Reason {
  file: string | null;
  tier: Tier;
  rule: Rule;
  zone?: Zone;
  // Null for a path rule or a file-level reason.
  line?: number | null;
  detail: string;
}

export interface FileTier {
  file: string;
  tier: Tier;
  zones: Zone[];
}

export interface Classification {
  tier: Tier;
  name: string;
  zones: Zone[];
  // The reasons that set the final tier. Weaker reasons sit in `files`.
  reasons: Reason[];
  files: FileTier[];
}

const docExtensions = new Set([".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"]);
const docNames = new Set(["license", "readme", "changelog", "contributing", "notice", "authors", "copying"]);
const styleExtensions = new Set([".css", ".scss", ".sass", ".less"]);
const markupExtensions = new Set([".html", ".htm"]);
const assetExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".woff", ".woff2", ".ttf", ".otf"]);

// Template engines whose files print variables, so a change to one can open an output hole.
const templateExtensions = new Set([".twig", ".njk", ".liquid", ".hbs", ".handlebars", ".mustache", ".ejs", ".erb", ".phtml", ".vue", ".svelte"]);

// Markers that make an .html file a template instead of static markup.
const echoMarkers = /<\?(?:php|=)|\{\{|\{%|<%|\{!!/;

function higher(a: Tier, b: Tier): Tier {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

function byType(input: FileInput): Reason {
  const ext = extname(input.path).toLowerCase();
  const name = basename(input.path).toLowerCase();
  const reason = (tier: Tier, rule: Rule, detail: string): Reason => ({ file: input.path, tier, rule, line: null, detail });

  if (docExtensions.has(ext) || (ext === "" && docNames.has(name))) return reason("T0", "file-type", "documentation");
  if (styleExtensions.has(ext)) return reason("T1", "file-type", "stylesheet");
  if (assetExtensions.has(ext)) return reason("T1", "file-type", "static asset");
  if (markupExtensions.has(ext)) {
    return input.content !== null && echoMarkers.test(input.content)
      ? reason("T2", "template", "template that echoes variables, so not HTML only")
      : reason("T1", "file-type", "static markup");
  }
  if (templateExtensions.has(ext)) return reason("T2", "template", "template that echoes variables, so not HTML only");
  return reason("T2", "file-type", "code or configuration");
}

/**
 * Assigns a tier to a change
 *
 * The tier comes from file types, zone matches and, when a reacher is given, the zone code that
 * calls a changed function. Rules only raise a tier, and lowering is a human action.
 */
export function classifyInputs(config: ZoneConfig, inputs: FileInput[], reacher?: Reacher): Classification {
  if (inputs.length === 0) {
    return {
      tier: "T0",
      name: TIER_NAMES.T0,
      zones: [],
      reasons: [{ file: null, tier: "T0", rule: "empty", detail: "no files changed" }],
      files: [],
    };
  }

  const all: Reason[] = [];
  const files: FileTier[] = [];
  const zones = new Set<Zone>();

  for (const input of inputs) {
    const scan = scanFile(config, input);
    const reasons: Reason[] = [byType(input)];
    for (const match of scan.removed) {
      reasons.push({ file: input.path, tier: "T3", rule: "removed-signal", zone: match.zone, line: match.line, detail: `removed: ${match.text}` });
    }
    for (const match of scan.matches) {
      reasons.push({
        file: input.path,
        tier: "T3",
        rule: match.kind === "path" ? "path" : "zone",
        zone: match.zone,
        line: match.line,
        detail: match.kind === "path" ? `path rule ${match.pattern}` : match.text,
      });
    }
    const reached = reacher ? reacher(config, input) : [];
    reasons.push(...reached);
    const tier = reasons.reduce<Tier>((best, reason) => higher(best, reason.tier), "T0");
    const fileZones = [...new Set([...scan.zones, ...reached.flatMap((reason) => (reason.zone ? [reason.zone] : []))])].sort();
    for (const zone of fileZones) zones.add(zone);
    files.push({ file: input.path, tier, zones: fileZones });
    all.push(...reasons);
  }

  const tier = all.reduce<Tier>((best, reason) => higher(best, reason.tier), "T0");
  return {
    tier,
    name: TIER_NAMES[tier],
    zones: [...zones].sort(),
    reasons: all.filter((reason) => reason.tier === tier),
    files,
  };
}
