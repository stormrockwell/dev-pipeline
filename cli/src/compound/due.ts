import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseYaml } from "../commands/scan-zones/yaml.ts";
import { listLogs } from "../run/log.ts";
import { excludeLocally } from "../task/git.ts";

export const COMPOUND_DIR = ".pipeline/compound";
const MARKER = `${COMPOUND_DIR}/last-run.json`;
const DAY = 24 * 60 * 60 * 1000;
const INTERVAL_DAYS = 7;

export const SETTINGS = ["weekly", "lead", "manual"] as const;
export type Setting = (typeof SETTINGS)[number];
export type Half = "quality" | "efficiency";

/**
 * When each half of the compounder last ran, as ISO times
 */
export type Marker = Partial<Record<Half, string>>;

/**
 * Whether a reminder is due, the line that says why, and the halves the setting covers
 */
export interface Due {
  due: boolean;
  line: string;
  covers: Half[];
}

/**
 * Reads the developer's setting from ~/.pipeline/config.yml
 *
 * A missing file or key means weekly. Anything else that is not a known setting throws.
 */
export function readSetting(home: string = homedir()): Setting {
  const path = join(home, ".pipeline", "config.yml");
  if (!existsSync(path)) return "weekly";
  const config = parseYaml(readFileSync(path, "utf8"));
  const value = config !== null && typeof config === "object" && !Array.isArray(config) ? config["compound"] : undefined;
  if (value === undefined || value === null) return "weekly";
  if (typeof value === "string" && (SETTINGS as readonly string[]).includes(value)) return value as Setting;
  throw new Error(`compound in ${path} takes ${SETTINGS.join(", ")}.`);
}

/**
 * Reads the time each half last ran, empty when neither has
 */
export function readMarker(repo: string): Marker {
  try {
    const raw = JSON.parse(readFileSync(join(repo, MARKER), "utf8")) as Record<string, unknown>;
    const marker: Marker = {};
    for (const half of ["quality", "efficiency"] as const) {
      const at = raw[half];
      if (typeof at === "string" && !Number.isNaN(Date.parse(at))) marker[half] = at;
    }
    return marker;
  } catch {
    return {};
  }
}

/**
 * Records that a half ran now, keeping the marker out of git
 */
export function recordRun(repo: string, half: Half, now: Date = new Date()): void {
  const marker = { ...readMarker(repo), [half]: now.toISOString() };
  mkdirSync(join(repo, COMPOUND_DIR), { recursive: true });
  excludeLocally(repo, `${COMPOUND_DIR}/`, MARKER);
  writeFileSync(join(repo, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
}

/**
 * How many run logs were written after a time, or all of them when there is none
 */
function logsSince(repo: string, from: number | null): number {
  const paths = listLogs(repo);
  return from === null ? paths.length : paths.filter((path) => statSync(path).mtimeMs > from).length;
}

/**
 * Decides whether to remind the developer, from local files only
 *
 * Weekly reads the efficiency half's time because it covers only the developer's own run logs.
 * Lead reads the later of the two, so either half run on demand resets the week.
 */
export function evaluate(setting: Setting, repo: string, now: Date = new Date()): Due {
  const covers: Half[] = setting === "lead" ? ["quality", "efficiency"] : setting === "weekly" ? ["efficiency"] : ["quality", "efficiency"];
  if (setting === "manual") return { due: false, line: "Not due. The setting is manual, so /compound never reminds.", covers };

  const marker = readMarker(repo);
  const times = (setting === "lead" ? [marker.quality, marker.efficiency] : [marker.efficiency]).filter((at): at is string => at !== undefined).map(Date.parse);
  const last = times.length === 0 ? null : Math.max(...times);
  const days = last === null ? null : Math.floor((now.getTime() - last) / DAY);
  const ago = days === null ? "No /compound run yet" : `Last /compound run was ${days} ${days === 1 ? "day" : "days"} ago`;

  if (days !== null && days < INTERVAL_DAYS) return { due: false, line: `Not due. ${ago}, and the setting ${setting} waits ${INTERVAL_DAYS} days.`, covers };
  if (setting === "lead") return { due: true, line: `${ago}. Run /compound?`, covers };

  const runs = logsSince(repo, last);
  if (runs === 0) return { due: false, line: `Not due. ${ago}, but no new run logs have come in.`, covers };
  return { due: true, line: `${ago}, ${runs} ${runs === 1 ? "run" : "runs"} since. Run /compound?`, covers };
}

/**
 * The SessionStart hook output that shows the developer the line and tells Claude to offer a run
 */
export function hookOutput(due: Due, setting: Setting): string {
  const halves = due.covers.join(" and ");
  const context = `Dev pipeline: ${due.line} Offer /compound to the developer once, in one line, and run it only when they say yes. The setting ${setting} covers the ${halves} ${due.covers.length === 1 ? "half" : "halves"}.`;
  return JSON.stringify({ systemMessage: due.line, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } });
}
