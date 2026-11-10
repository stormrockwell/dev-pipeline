/**
 * The parts of a gate record the PR body reads
 *
 * The record is read as JSON, so a field the reviewers add later, such as accepted, is optional.
 */
export interface RecordJson {
  work: string;
  pr: string | null;
  tasks: { id: string; tier: string; zones: string[]; status: string | null }[];
  gates: { task: string; gate: string; result: "pass" | "fail" | "skip" | "pending"; note: string | null }[];
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
 */
export function failedGates(record: RecordJson): string[] {
  return record.gates.filter((gate) => gate.result === "fail").map((gate) => `${gate.gate} failed for task ${gate.task}`);
}
