import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globToRegExp } from "./glob.ts";
import { packs } from "./packs.ts";
import { GROUPS, ZONES, type Group, type PathRule, type Signal, type Zone, type ZoneConfig } from "./types.ts";
import { parseYaml, type YamlValue } from "./yaml.ts";

export const CONFIG_PATH = ".pipeline/sensitive.yml";

const TOP_KEYS = ["packs", "paths", "signals", "critical"];

/** The guardrail paths that STRATEGY names as designated, used when a sensitive.yml omits `critical`. */
export const DEFAULT_CRITICAL = [".github/**", ".pipeline/**", ".claude/**"];
const SIGNAL_KEYS = ["pattern", "zone", "near", "only", "flags"];
const PATH_KEYS = ["path", "zone"];

/** Names from the 0.6 spike, so an old file gets a pointer to the current zone instead of a bare error. */
const legacyZones: Record<string, Zone> = {
  authentication: "auth",
  authorization: "authz",
  "browser-sinks": "input",
  suppressions: "guardrails",
};

function isMap(value: YamlValue | undefined): value is { [key: string]: YamlValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(where: string, message: string): never {
  throw new Error(`${CONFIG_PATH}: ${where}: ${message}`);
}

function checkKeys(where: string, map: { [key: string]: YamlValue }, allowed: string[]): void {
  for (const key of Object.keys(map)) {
    if (!allowed.includes(key)) fail(where, `unknown key "${key}". Allowed keys: ${allowed.join(", ")}.`);
  }
}

function asZone(where: string, value: YamlValue | undefined): Zone {
  if ((ZONES as readonly string[]).includes(value as string)) return value as Zone;
  const hint = typeof value === "string" && legacyZones[value] ? ` Use "${legacyZones[value]}" instead.` : "";
  return fail(where, `zone must be one of ${ZONES.join(", ")}, got ${JSON.stringify(value)}.${hint}`);
}

function asString(where: string, key: string, value: YamlValue | undefined): string {
  if (typeof value !== "string" || value === "") fail(where, `${key} must be a non-empty string.`);
  return value as string;
}

function compile(where: string, pattern: string, flags: string): void {
  try {
    new RegExp(pattern, flags);
  } catch (error) {
    fail(where, `invalid regular expression ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parsePaths(value: YamlValue | undefined): PathRule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return fail("paths", "must be a list.");
  return value.map((item, index) => {
    const where = `paths[${index}]`;
    let rule: PathRule;
    if (typeof item === "string") {
      rule = { glob: item, zone: "guardrails" };
    } else if (isMap(item)) {
      checkKeys(where, item, PATH_KEYS);
      rule = { glob: asString(where, "path", item.path), zone: item.zone === undefined ? "guardrails" : asZone(where, item.zone) };
    } else {
      return fail(where, "must be a glob string or a map with path and zone.");
    }
    try {
      globToRegExp(rule.glob);
    } catch (error) {
      fail(where, error instanceof Error ? error.message : String(error));
    }
    return rule;
  });
}

function parseSignals(value: YamlValue | undefined): Signal[] {
  if (value === undefined || value === null) return [];
  if (!isMap(value)) return fail("signals", "must map a group name to a list of signals.");
  const result: Signal[] = [];
  for (const [group, list] of Object.entries(value)) {
    if (!(GROUPS as readonly string[]).includes(group)) fail(`signals.${group}`, `unknown group. Groups: ${GROUPS.join(", ")}.`);
    if (list === null) continue;
    if (!Array.isArray(list)) fail(`signals.${group}`, "must be a list.");
    (list as YamlValue[]).forEach((item, index) => {
      const where = `signals.${group}[${index}]`;
      if (!isMap(item)) return fail(where, "must be a map with pattern and zone.");
      checkKeys(where, item, SIGNAL_KEYS);
      const signal: Signal = {
        group: group as Group,
        pattern: asString(where, "pattern", item.pattern),
        zone: asZone(where, item.zone),
      };
      if (item.flags !== undefined) {
        signal.flags = asString(where, "flags", item.flags);
        if (!/^[ims]+$/.test(signal.flags)) fail(where, 'flags may contain only "i", "m" and "s".');
      }
      if (item.near !== undefined) signal.near = asString(where, "near", item.near);
      if (item.only !== undefined) {
        if (item.only !== "removed") fail(where, 'only must be "removed".');
        signal.only = "removed";
      }
      compile(where, signal.pattern, signal.flags ?? "");
      if (signal.near) compile(where, signal.near, signal.flags ?? "");
      result.push(signal);
    });
  }
  return result;
}

function parsePacks(value: YamlValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return fail("packs", "must be a list of pack names.");
  return value.map((name) => {
    if (typeof name !== "string" || !packs[name]) {
      return fail("packs", `unknown pack ${JSON.stringify(name)}. Built-in packs: ${Object.keys(packs).join(", ")}.`);
    }
    return name;
  });
}

function parseCritical(value: YamlValue | undefined): string[] {
  if (value === undefined) return DEFAULT_CRITICAL;
  if (value === null) return [];
  if (!Array.isArray(value)) return fail("critical", "must be a list of globs.");
  return value.map((item, index) => {
    const glob = asString(`critical[${index}]`, "glob", item);
    try {
      globToRegExp(glob);
    } catch (error) {
      fail(`critical[${index}]`, error instanceof Error ? error.message : String(error));
    }
    return glob;
  });
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function combine(source: ZoneConfig["source"], names: string[], paths: PathRule[], signals: Signal[], critical: string[]): ZoneConfig {
  const chosen = names.map((name) => packs[name]!);
  return {
    source,
    critical,
    packs: names,
    paths: unique([...paths, ...chosen.flatMap((pack) => pack.paths)], (rule) => `${rule.glob}\0${rule.zone}`),
    signals: unique(
      [...signals, ...chosen.flatMap((pack) => pack.signals)],
      (signal) => JSON.stringify([signal.group, signal.zone, signal.pattern, signal.near, signal.only, signal.flags]),
    ),
  };
}

/** Every built-in pack, which is what a repo without a sensitive.yml gets. */
export function builtinConfig(): ZoneConfig {
  return combine("builtin", Object.keys(packs), [], [], DEFAULT_CRITICAL);
}

export function parseConfig(text: string): ZoneConfig {
  let doc: YamlValue;
  try {
    doc = parseYaml(text);
  } catch (error) {
    throw new Error(`${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!isMap(doc)) return fail("document", "must be a mapping with packs, paths and signals.");
  checkKeys("document", doc, TOP_KEYS);
  return combine("file", parsePacks(doc.packs), parsePaths(doc.paths), parseSignals(doc.signals), parseCritical(doc.critical));
}

export function loadConfig(root: string): ZoneConfig {
  const file = join(root, CONFIG_PATH);
  return existsSync(file) ? parseConfig(readFileSync(file, "utf8")) : builtinConfig();
}
