export type Decision = "allow" | "ask" | "deny";

export interface Verdict {
  decision: Decision;
  // The rule id, which also appears in the reason so a denial can be traced.
  rule: string;
  reason: string;
}

export const ALLOW: Verdict = { decision: "allow", rule: "none", reason: "No rule matched." };

const strength: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };

export function verdict(decision: Decision, rule: string, message: string): Verdict {
  return { decision, rule, reason: `${message} (rule: ${rule})` };
}

// Returns the strictest verdict, keeping the first one when two are equally strict.
export function strictest(verdicts: Verdict[]): Verdict {
  let result = ALLOW;
  for (const candidate of verdicts) {
    if (strength[candidate.decision] > strength[result.decision]) result = candidate;
  }
  return result;
}
