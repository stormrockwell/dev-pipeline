/**
 * The parts of a gate record the PR body reads
 *
 * The record is read as JSON, so a field the reviewers add later, such as accepted, is optional.
 */
export interface RecordJson {
  work: string;
  pr: string | null;
  tasks: { id: string; tier: string; zones: string[]; status: string | null; commits?: string | null }[];
  gates: { task: string; gate: string; result: "pass" | "fail" | "skip" | "pending"; note: string | null; head?: string }[];
  accepted?: { task: string; gate: string; finding: string; reason: string }[];
}

// pr-check splits Skipped and Accepted items on commas, so a comma inside an item would split it.
function item(text: string): string {
  return text.replaceAll(",", ";").replace(/\s+/g, " ").trim();
}

/**
 * The Auditors section, generated from the gate record
 *
 * A gate is Ran when it passed for every task that has it. Otherwise it is Skipped, with the
 * reason a skip recorded, or "not run" for a gate nobody recorded. Accepted appears only when a
 * finding was dismissed instead of fixed. A failed gate has no line, because the body is not
 * written while one stands.
 */
export function auditors(record: RecordJson): string[] {
  const names = [...new Set(record.gates.map((gate) => gate.gate))];
  const ran: string[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    const results = record.gates.filter((gate) => gate.gate === name);
    if (results.every((gate) => gate.result === "pass")) {
      ran.push(item(name));
      continue;
    }
    const reasons = results
      .filter((gate) => gate.result !== "pass")
      .map((gate) => {
        const reason = gate.result === "skip" ? (gate.note ?? "skipped") : "not run";
        return results.length > 1 || record.tasks.length > 1 ? `task ${gate.task}: ${reason}` : reason;
      });
    skipped.push(`${item(name)} (${item(reasons.join("; "))})`);
  }
  const accepted = (record.accepted ?? []).map((entry) => `${item(entry.gate)} on task ${entry.task}: ${item(entry.finding)} (${item(entry.reason)})`);
  const lines = [
    ...(ran.length > 0 ? [`- Ran: ${ran.join(", ")}`] : []),
    ...(skipped.length > 0 ? [`- Skipped: ${skipped.join(", ")}`] : []),
    ...(accepted.length > 0 ? [`- Accepted: ${accepted.join(", ")}`] : []),
  ];
  return lines.length > 0 ? lines : ["- Skipped: reviews (the plan lists no gates)"];
}

/**
 * Gates that failed, which hold the PR until the fix loop clears them
 *
 * An open Important security finding fails its gate, and a security finding is never waived, so
 * it holds the PR until a later round confirms the fix. A gate that judged one commit holds the PR
 * too when the task has moved past that commit, because its pass says nothing about the new code.
 */
export function failedGates(record: RecordJson): string[] {
  return [...record.gates.filter((gate) => gate.result === "fail").map((gate) => `${gate.gate} failed for task ${gate.task}`), ...staleGates(record).map((stale) => stale.message)];
}

/**
 * Gates that passed at a commit the task has since moved past
 */
export function staleGates(record: RecordJson): { task: string; gate: string; at: string; now: string; message: string }[] {
  const stale = [];
  for (const gate of record.gates.filter((entry) => entry.result === "pass" && entry.head)) {
    const head = record.tasks.find((task) => task.id === gate.task)?.commits?.split("..")[1];
    if (head && !gate.head!.startsWith(head)) {
      const [at, now] = [gate.head!.slice(0, 7), head.slice(0, 7)];
      stale.push({ task: gate.task, gate: gate.gate, at, now, message: `${gate.gate} passed for task ${gate.task} at ${at}, and the task is at ${now}, so review it again` });
    }
  }
  return stale;
}

/**
 * Security gates nobody recorded, or that were recorded as a skip
 *
 * The mutation check counts as one, because a security test that proves nothing is a security gap.
 * Each names the task, its tier, the gate and why it did not run: the skip note, or "not recorded".
 * A failed gate is not here, because failedGates holds the PR for it.
 */
export function securityGaps(record: RecordJson): { task: string; tier: string; gate: string; skipped: boolean; reason: string }[] {
  return record.gates
    .filter((gate) => /security (?:pass|review)|^mutation check$/.test(gate.gate) && (gate.result === "pending" || gate.result === "skip"))
    .map((gate) => ({
      task: gate.task,
      tier: record.tasks.find((task) => task.id === gate.task)?.tier ?? "",
      gate: gate.gate,
      skipped: gate.result === "skip",
      reason: gate.result === "skip" ? (gate.note ?? "skipped").replace(/\s+/g, " ").trim() : "not recorded",
    }));
}

/**
 * The Risk lines for a security gate that did not run, one per task
 */
export function securityCallouts(record: RecordJson): string[] {
  return securityGaps(record).map((gap) => `Security review: not run for task ${gap.task} (${gap.reason}).`);
}

/**
 * T3 tasks whose security gate did not run, which hold the PR
 */
export function blockedSecurity(record: RecordJson): string[] {
  return securityGaps(record)
    .filter((gap) => gap.tier === "T3")
    .map((gap) => (gap.skipped ? `${gap.gate} skipped for task ${gap.task} (${gap.reason}), and a T3 task needs it` : `${gap.gate} not recorded for task ${gap.task}, and a T3 task needs it`));
}
