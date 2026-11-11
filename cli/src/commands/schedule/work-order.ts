import type { Tier } from "../classify/tier.ts";
import { ZONES, type Zone } from "../scan-zones/types.ts";
import { parseYaml, type YamlValue } from "../scan-zones/yaml.ts";

export type Level = "guide" | "confirm" | "autopilot";

export interface Task {
  id: string;
  title: string;
  files: string[];
  needs: string[];
  // Null means undeclared, which the scheduler treats as shared with every task.
  interfaces: string[] | null;
  state: string[] | null;
  tier: Tier | null;
  zones: Zone[] | null;
  raised: string | null;
  joins: string | null;
  uncertain: boolean;
  loweredBy: string | null;
  loweredReason: string | null;
}

export interface WorkOrder {
  title: string;
  level: Level;
  tasks: Task[];
}

const TIERS: Tier[] = ["T0", "T1", "T2", "T3"];
const LEVELS: Level[] = ["guide", "confirm", "autopilot"];
const TOP_KEYS = ["title", "level", "tasks"];
const TASK_KEYS = ["id", "title", "files", "needs", "interfaces", "state", "tier", "zones", "raised", "joins", "uncertain", "lowered_by", "lowered_reason"];

type Map = { [key: string]: YamlValue };

function isMap(value: YamlValue | undefined): value is Map {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: YamlValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number") return String(value).trim() || null;
  throw new Error(`expected text, got ${JSON.stringify(value)}`);
}

function list(value: YamlValue | undefined, what: string): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new Error(`${what} must be a list`);
  return value.map((item) => {
    const entry = text(item);
    if (entry === null) throw new Error(`${what} has an empty entry`);
    return entry;
  });
}

function frontmatter(source: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) throw new Error("a work order starts with a --- frontmatter block");
  return match[1]!;
}

function parseTask(raw: YamlValue, index: number): Task {
  if (!isMap(raw)) throw new Error(`task ${index + 1} must be a mapping`);
  const id = text(raw.id);
  if (id === null) throw new Error(`task ${index + 1} needs an id`);
  const where = `task ${id}`;
  for (const key of Object.keys(raw)) {
    if (!TASK_KEYS.includes(key)) throw new Error(`${where} has unknown key "${key}"`);
  }
  const title = text(raw.title);
  if (title === null) throw new Error(`${where} needs a title`);
  const files = list(raw.files, `${where} files`) ?? [];
  if (files.length === 0) throw new Error(`${where} owns no files`);

  const tier = text(raw.tier);
  if (tier !== null && !TIERS.includes(tier as Tier)) throw new Error(`${where} tier must be T0, T1, T2 or T3`);
  const zones = list(raw.zones, `${where} zones`);
  for (const zone of zones ?? []) {
    if (!ZONES.includes(zone as Zone)) throw new Error(`${where} has unknown zone "${zone}", use one of ${ZONES.join(", ")}`);
  }
  const loweredBy = text(raw.lowered_by);
  const loweredReason = text(raw.lowered_reason);
  if (loweredBy !== null && loweredReason === null) throw new Error(`${where} lowered_by needs lowered_reason`);

  return {
    id,
    title,
    files,
    needs: list(raw.needs, `${where} needs`) ?? [],
    interfaces: list(raw.interfaces, `${where} interfaces`),
    state: list(raw.state, `${where} state`),
    tier: tier as Tier | null,
    zones: zones as Zone[] | null,
    raised: text(raw.raised),
    joins: text(raw.joins),
    uncertain: raw.uncertain === true,
    loweredBy,
    loweredReason,
  };
}

export function parseWorkOrder(source: string): WorkOrder {
  const raw = parseYaml(frontmatter(source));
  if (!isMap(raw)) throw new Error("the frontmatter must be a mapping");
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.includes(key)) throw new Error(`unknown key "${key}"`);
  }
  const title = text(raw.title);
  if (title === null) throw new Error("a work order needs a title");
  const level = text(raw.level) ?? "confirm";
  if (!LEVELS.includes(level as Level)) throw new Error("level must be guide, confirm or autopilot");
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) throw new Error("a work order needs at least one task");

  const tasks = raw.tasks.map(parseTask);
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`duplicate task id ${task.id}`);
    ids.add(task.id);
  }
  for (const task of tasks) {
    if (task.joins !== null && !ids.has(task.joins)) throw new Error(`task ${task.id} joins unknown task ${task.joins}`);
  }
  return { title, level: level as Level, tasks };
}
