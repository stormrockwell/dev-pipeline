import { securityGaps, staleGates, type RecordJson } from "../pr-body/auditors.ts";

/**
 * The state and description of the pipeline/security commit status
 */
export interface SecurityStatus {
  state: "success" | "failure";
  description: string;
}

// GitHub rejects a status description over 140 characters.
const LIMIT = 140;

function clip(text: string): string {
  return text.length <= LIMIT ? text : `${text.slice(0, LIMIT - 3)}...`;
}

/**
 * Success when every task's security gate passed at the task's head, otherwise failure naming what is missing
 *
 * A skipped or unrecorded gate is missing, a gate that failed is failed, and a pass at an older
 * commit than the task's is stale.
 */
export function securityStatus(record: RecordJson): SecurityStatus {
  const isSecurity = (gate: string) => /security (?:pass|review)/.test(gate);
  const security = record.gates.filter((gate) => isSecurity(gate.gate));
  const problems = [
    ...securityGaps(record).map((gap) => `missing: ${gap.gate} for task ${gap.task} (${gap.reason})`),
    ...security.filter((gate) => gate.result === "fail").map((gate) => `failed: ${gate.gate} for task ${gate.task}`),
    ...staleGates(record).filter((stale) => isSecurity(stale.gate)).map((stale) => `stale: ${stale.gate} for task ${stale.task} passed at ${stale.at}, task is at ${stale.now}`),
  ];
  if (problems.length > 0) return { state: "failure", description: clip(`Security gate ${problems.join("; ")}`) };
  const count = new Set(security.map((gate) => gate.task)).size;
  return { state: "success", description: `Security gate passed for ${count} ${count === 1 ? "task" : "tasks"}` };
}

/**
 * The gh api call that posts the status for one commit
 *
 * The description drops quotes and shell syntax, so the call is one plain command.
 */
export function statusCall(repo: string, sha: string, status: SecurityStatus): string {
  const description = status.description.replace(/['"`$;|&<>\\]/g, "").trim();
  return `gh api repos/${repo}/statuses/${sha} -f state=${status.state} -f context=pipeline/security -f description='${description}'`;
}
