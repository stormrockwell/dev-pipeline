import type { Task } from "./work-order.ts";

export type OrderInput = Pick<Task, "id" | "files" | "needs" | "interfaces" | "state">;

export interface Edge {
  before: string;
  after: string;
  reason: string;
}

export interface Order {
  // Each wave runs in parallel, and the waves run one after another.
  waves: string[][];
  edges: Edge[];
}

function normalize(path: string): string {
  return path.replace(/^\.\//, "");
}

// A path ending in a slash owns everything below it.
function overlap(a: string, b: string): string | null {
  const [x, y] = [normalize(a), normalize(b)];
  if (x === y) return x;
  if (x.endsWith("/") && y.startsWith(x)) return y;
  if (y.endsWith("/") && x.startsWith(y)) return x;
  return null;
}

function shared(a: string[], b: string[]): string | null {
  return a.find((item) => b.includes(item)) ?? null;
}

function conflict(a: OrderInput, b: OrderInput): string | null {
  for (const x of a.files) {
    for (const y of b.files) {
      const file = overlap(x, y);
      if (file !== null) return `shares file ${file}`;
    }
  }
  if (a.interfaces === null || b.interfaces === null || a.state === null || b.state === null) return "undeclared interfaces or state";
  const name = shared(a.interfaces, b.interfaces);
  if (name !== null) return `shares interface ${name}`;
  const state = shared(a.state, b.state);
  if (state !== null) return `shares state ${state}`;
  return null;
}

// Orders by `needs`, breaking ties by declaration order so the output is stable.
function topological(tasks: OrderInput[]): OrderInput[] {
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const need of task.needs) {
      if (!ids.has(need)) throw new Error(`task ${task.id} needs unknown task ${need}`);
    }
  }
  const done = new Set<string>();
  const sorted: OrderInput[] = [];
  while (sorted.length < tasks.length) {
    const next = tasks.find((task) => !done.has(task.id) && task.needs.every((need) => done.has(need)));
    if (!next) {
      const stuck = tasks.filter((task) => !done.has(task.id)).map((task) => task.id);
      throw new Error(`the tasks' needs form a cycle: ${stuck.join(", ")}`);
    }
    done.add(next.id);
    sorted.push(next);
  }
  return sorted;
}

// Serial by default: two tasks share a wave only when nothing ties them together.
export function orderTasks(tasks: OrderInput[]): Order {
  const sorted = topological(tasks);
  const edges: Edge[] = [];
  const level = new Map<string, number>();
  sorted.forEach((task, j) => {
    let depth = 0;
    for (const before of sorted.slice(0, j)) {
      const reason = task.needs.includes(before.id) ? `needs ${before.id}` : conflict(before, task);
      if (reason === null) continue;
      edges.push({ before: before.id, after: task.id, reason });
      depth = Math.max(depth, level.get(before.id)! + 1);
    }
    level.set(task.id, depth);
  });
  const waves: string[][] = [];
  for (const task of sorted) (waves[level.get(task.id)!] ??= []).push(task.id);
  return { waves, edges };
}
