import type { Tier } from "../classify/tier.ts";
import { APPROVALS } from "../risk-gate/risk.ts";
import { matchesGlob } from "../scan-zones/glob.ts";
import type { Zone } from "../scan-zones/types.ts";
import { orderTasks, type Order } from "./order.ts";
import type { Level, Task, WorkOrder } from "./work-order.ts";

export interface Rules {
  tier: Tier;
  zones: Zone[];
}

export interface DiffFile extends Rules {
  file: string;
}

export interface PlanInput {
  order: WorkOrder;
  // Classifies a task's owned files with the same rules as `pipeline classify`.
  rules: (files: string[]) => Rules;
  // The designated paths that need two peers on T3 work.
  critical: string[];
  // Names that can never sign a lowering: the author's git identities.
  authors: string[];
  // Each changed file with its tier, when the plan is checked against a real diff.
  diff: DiffFile[] | null;
  // Each task's tier and zones from the last schedule, which hold like the rules so nobody undoes a raise quietly.
  previous: Map<string, Rules> | null;
}

export type ReviewPath = "zone" | "standard";

export interface PlannedTask {
  id: string;
  title: string;
  files: string[];
  tier: Tier;
  rulesTier: Tier;
  zones: Zone[];
  path: ReviewPath;
  gates: string[];
}

export interface Pr {
  name: string;
  tasks: string[];
  path: ReviewPath;
  peers: number;
  stacksOn: string[];
}

export type NoteKind = "raised" | "kept" | "lowered" | "refused" | "joined" | "diff";

export interface Note {
  kind: NoteKind;
  task: string;
  text: string;
}

export interface Plan {
  title: string;
  level: Level;
  tasks: PlannedTask[];
  prs: Pr[];
  order: Order;
  confirm: { needed: boolean; reason: string };
  notes: Note[];
  unplanned: DiffFile[];
}

const TIERS: Tier[] = ["T0", "T1", "T2", "T3"];

// The base gates per tier from the STRATEGY tier table. Signal-driven reviews such as performance are added by the agent.
export const GATES: Record<Tier, string[]> = {
  T0: ["PR standard", "light security pass"],
  T1: ["standards", "light security pass", "axe"],
  T2: ["TDD", "simplifier", "standards", "spec", "quick security review"],
  T3: ["TDD and security tests", "simplifier proposals only", "standards", "spec", "full security review with verifier vote", "mutation check"],
};

// Autopilot treats a plan larger than this as costly enough to confirm, standing in for a cost estimate.
export const AUTOPILOT_MAX_TASKS = 5;

// Agents and bots never count as a peer, whatever name they sign with.
const NOT_A_PEER = /\[bot\]$|\bclaude\b|\bagent\b|\bbot\b/i;

function higher(a: Tier, b: Tier): Tier {
  return TIERS.indexOf(a) >= TIERS.indexOf(b) ? a : b;
}

function below(a: Tier, b: Tier): boolean {
  return TIERS.indexOf(a) < TIERS.indexOf(b);
}

function zoneList(zones: Zone[]): string {
  return zones.length === 1 ? `zone ${zones[0]}` : `zones ${zones.join(", ")}`;
}

function owns(task: Task, file: string): boolean {
  const path = file.replace(/^\.\//, "");
  return task.files.some((entry) => {
    const owned = entry.replace(/^\.\//, "");
    return owned === path || (owned.endsWith("/") && path.startsWith(owned));
  });
}

function canLower(by: string, authors: string[]): boolean {
  const name = by.toLowerCase();
  return !NOT_A_PEER.test(by) && !authors.some((author) => author.toLowerCase() === name);
}

function classifyTask(task: Task, input: PlanInput, notes: Note[]): PlannedTask {
  const classified = input.rules(task.files);
  const last = input.previous?.get(task.id);
  const rules: Rules = last
    ? { tier: higher(classified.tier, last.tier), zones: [...new Set([...classified.zones, ...last.zones])].sort() }
    : classified;
  const recorded = task.tier ?? rules.tier;
  const missing = task.zones === null ? [] : rules.zones.filter((zone) => !task.zones!.includes(zone));
  const lowering = below(recorded, rules.tier) || missing.length > 0;

  let tier = higher(rules.tier, recorded);
  let zones = [...new Set([...rules.zones, ...(task.zones ?? [])])].sort();
  if (lowering && task.loweredBy !== null && canLower(task.loweredBy, input.authors)) {
    tier = recorded;
    zones = [...(task.zones ?? [])].sort();
    const parts = [below(recorded, rules.tier) ? `from ${rules.tier} to ${recorded}` : `at ${recorded}`];
    if (missing.length > 0) parts.push(`${zoneList(missing)} removed`);
    notes.push({ kind: "lowered", task: task.id, text: `task ${task.id} lowered ${parts.join(", ")}, by ${task.loweredBy}: ${task.loweredReason}` });
  } else if (lowering && task.loweredBy !== null) {
    notes.push({
      kind: "refused",
      task: task.id,
      text: `task ${task.id} stays ${tier}: ${task.loweredBy} cannot lower it, because only a peer reviewer can, never the author or an agent`,
    });
  } else if (lowering) {
    const kept = rules.zones.length > 0 ? ` with ${zoneList(rules.zones)}` : "";
    notes.push({
      kind: "kept",
      task: task.id,
      text: `task ${task.id} stays ${tier}${kept}: the work order said ${recorded}, and only a peer can lower a tier or remove a zone`,
    });
  } else if (below(classified.tier, recorded) && task.raised !== null) {
    notes.push({ kind: "raised", task: task.id, text: `task ${task.id} raised to ${recorded}: ${task.raised}` });
  }

  // The diff pass runs after any lowering, because a peer signed off on the plan and not on code that came later.
  let rulesTier = classified.tier;
  for (const changed of input.diff?.filter((file) => owns(task, file.file)) ?? []) {
    rulesTier = higher(rulesTier, changed.tier);
    if (!below(tier, changed.tier) && changed.zones.every((zone) => zones.includes(zone))) continue;
    tier = higher(tier, changed.tier);
    zones = [...new Set([...zones, ...changed.zones])].sort();
    const where = changed.zones.length > 0 ? ` in ${zoneList(changed.zones)}` : "";
    notes.push({ kind: "diff", task: task.id, text: `task ${task.id} raised to ${tier} by its diff: ${changed.file}${where}` });
  }

  return { id: task.id, title: task.title, files: task.files, tier, rulesTier, zones, path: tier === "T3" ? "zone" : "standard", gates: GATES[tier] };
}

function resolveJoin(id: string, tasks: Map<string, Task>, seen: string[] = []): string {
  const target = tasks.get(id)!.joins;
  if (target === null) return id;
  if (seen.includes(id)) throw new Error(`tasks ${seen.join(", ")} join each other in a loop`);
  return resolveJoin(target, tasks, [...seen, id]);
}

/**
 * Groups tasks into PRs by human review path. A task's rank counts the review path changes on its
 * longest dependency chain, so a PR never waits on a PR that waits on it, and same-path tasks at one
 * rank share a PR. A joined task rides in its target's PR.
 */
function splitPrs(order: WorkOrder, planned: Map<string, PlannedTask>, sequence: string[], critical: string[], notes: Note[]): Pr[] {
  const tasks = new Map(order.tasks.map((task) => [task.id, task]));
  const rank = new Map<string, number>();
  for (const id of sequence) {
    const path = planned.get(id)!.path;
    let value = 0;
    for (const need of tasks.get(id)!.needs) value = Math.max(value, rank.get(need)! + (planned.get(need)!.path === path ? 0 : 1));
    rank.set(id, value);
  }

  const groups = new Map<string, string[]>();
  const keyOf = (id: string) => `${rank.get(id)}:${planned.get(id)!.path === "zone" ? 0 : 1}`;
  for (const id of sequence) {
    const home = resolveJoin(id, tasks);
    const key = keyOf(home);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(id);
  }

  const keys = [...groups.keys()].sort((a, b) => {
    const [ra, pa] = a.split(":").map(Number) as [number, number];
    const [rb, pb] = b.split(":").map(Number) as [number, number];
    return ra - rb || pa - pb;
  });
  const prOf = new Map<string, string>();
  const prs: Pr[] = keys.map((key, index) => {
    const name = String.fromCharCode(65 + index);
    const ids = groups.get(key)!.sort((a, b) => order.tasks.findIndex((t) => t.id === a) - order.tasks.findIndex((t) => t.id === b));
    for (const id of ids) prOf.set(id, name);
    const zone = ids.some((id) => planned.get(id)!.path === "zone");
    const onCritical = zone && ids.some((id) => planned.get(id)!.tier === "T3" && planned.get(id)!.files.some((file) => critical.some((glob) => matchesGlob(glob, file))));
    return { name, tasks: ids, path: zone ? "zone" : "standard", peers: APPROVALS[onCritical ? "critical" : "high"], stacksOn: [] };
  });

  for (const pr of prs) {
    const stacks = new Set<string>();
    for (const id of pr.tasks) {
      for (const need of tasks.get(id)!.needs) if (prOf.get(need) !== pr.name) stacks.add(prOf.get(need)!);
    }
    pr.stacksOn = [...stacks].sort();
  }
  for (const task of order.tasks) {
    if (task.joins === null) continue;
    notes.push({ kind: "joined", task: task.id, text: `task ${task.id} rides in PR ${prOf.get(task.id)} with task ${task.joins}, because it cannot stand alone` });
  }
  return prs;
}

function confirmation(level: Level, tasks: PlannedTask[], order: WorkOrder): Plan["confirm"] {
  if (level !== "autopilot") return { needed: true, reason: `level ${level}` };
  const t3 = tasks.find((task) => task.tier === "T3");
  if (t3) return { needed: true, reason: `task ${t3.id} is T3` };
  const uncertain = order.tasks.find((task) => task.uncertain);
  if (uncertain) return { needed: true, reason: `task ${uncertain.id} is uncertain` };
  if (tasks.length > AUTOPILOT_MAX_TASKS) return { needed: true, reason: `more than ${AUTOPILOT_MAX_TASKS} tasks` };
  return { needed: false, reason: "autopilot and no T3 task" };
}

export function buildPlan(input: PlanInput): Plan {
  const { order } = input;
  const schedule = orderTasks(order.tasks);
  const notes: Note[] = [];
  const tasks = order.tasks.map((task) => classifyTask(task, input, notes));
  const planned = new Map(tasks.map((task) => [task.id, task]));
  const prs = splitPrs(order, planned, schedule.waves.flat(), input.critical, notes);
  const unplanned = input.diff?.filter((file) => !order.tasks.some((task) => owns(task, file.file))) ?? [];
  return { title: order.title, level: order.level, tasks, prs, order: schedule, confirm: confirmation(order.level, tasks, order), notes, unplanned };
}
