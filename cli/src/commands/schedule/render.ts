import type { Order } from "./order.ts";
import type { NoteKind, Plan } from "./plan.ts";

const LABEL_WIDTH = 8;
const TITLE_WIDTH = 40;

// Notes that need the developer's eye come first, because the screen leads with decisions.
const NOTE_LABELS: [NoteKind, string][] = [
  ["refused", "Refused"],
  ["kept", "Kept"],
  ["lowered", "Lowered"],
  ["diff", "Raised"],
  ["raised", "Raised"],
  ["joined", "Joined"],
];

function line(label: string, text: string): string {
  return `${label.padEnd(LABEL_WIDTH)} ${text}`;
}

export function joinIds(ids: string[]): string {
  if (ids.length <= 1) return ids.join("");
  return `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
}

function clip(title: string): string {
  return title.length > TITLE_WIDTH ? `${title.slice(0, TITLE_WIDTH - 3)}...` : title;
}

function orderText(order: Order): string {
  if (order.waves.length === 1) return order.waves[0]!.length === 1 ? "one task" : `${joinIds(order.waves[0]!)} in parallel`;
  return order.waves
    .map((wave, index) => {
      const ids = `${joinIds(wave)}${wave.length > 1 ? " in parallel" : ""}`;
      if (index === 0) return ids;
      const reasons = wave.map((id) => order.edges.find((edge) => edge.after === id)!).map((edge) => (edge.reason.startsWith("needs") ? edge.reason : `${edge.reason} with ${edge.before}`));
      return `then ${ids} (${[...new Set(reasons)].join("; ")})`;
    })
    .join(", ");
}

export function renderPlan(plan: Plan): string {
  const width = Math.max(...plan.tasks.map((task) => clip(task.title).length));
  const out = [`Work order: ${plan.title}`];
  for (const task of plan.tasks) {
    const zones = task.zones.length > 0 ? `${task.zones.map((zone) => `zone:${zone}`).join(", ")}  ` : "";
    out.push(line(`Task ${task.id}`, `${clip(task.title).padEnd(width)}   ${task.tier}  ${zones}${task.gates.join(", ")}`));
  }
  for (const pr of plan.prs) {
    const stacked = pr.stacksOn.length > 0 ? `, stacked on PR ${joinIds(pr.stacksOn)}` : "";
    const peers = `${pr.peers} peer approval${pr.peers === 1 ? "" : "s"}`;
    out.push(line(`PR ${pr.name}`, `task${pr.tasks.length === 1 ? "" : "s"} ${joinIds(pr.tasks)}, ${pr.path}, ${peers}${stacked}`));
  }
  out.push(line("Order", orderText(plan.order)));
  for (const file of plan.unplanned) {
    const zones = file.zones.length > 0 ? `  ${file.zones.map((zone) => `zone:${zone}`).join(", ")}` : "";
    out.push(line("Unplanned", `${file.file}  ${file.tier}${zones}, owned by no task`));
  }
  for (const [kind, label] of NOTE_LABELS) {
    for (const note of plan.notes.filter((entry) => entry.kind === kind)) out.push(line(label, note.text));
  }
  if (plan.confirm.needed) {
    out.push(line("Confirm", `needed, ${plan.confirm.reason}`), 'Reply "go", or edit a line.');
  } else {
    out.push(line("Confirm", `skipped, ${plan.confirm.reason}, so the build starts now`));
  }
  return out.join("\n");
}
