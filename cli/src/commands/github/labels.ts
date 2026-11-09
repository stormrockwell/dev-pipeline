import { RISKS, riskLabel, zoneLabel, type Risk } from "../risk-gate/risk.ts";
import { ZONES, type Zone } from "../scan-zones/types.ts";

export interface LabelDefinition {
  name: string;
  // Six hex digits without a leading hash, as the GitHub API takes it.
  color: string;
  description: string;
}

const riskStyle: Record<Risk, { color: string; description: string }> = {
  low: { color: "0e8a16", description: "T0 or T1 change. Needs 1 peer approval, never the author." },
  medium: { color: "fbca04", description: "T2 logic change. Needs 1 peer approval, never the author." },
  high: { color: "d93f0b", description: "T3 sensitive change. Needs 1 peer approval, never the author." },
  critical: { color: "b60205", description: "T3 on a designated path. Needs 2 peer approvals, never the author." },
};

const zoneDescriptions: Record<Zone, string> = {
  auth: "Login, sessions, cookies, JWT, OAuth and password checks.",
  authz: "Capability checks, permission callbacks, roles and auth middleware.",
  csrf: "Nonces, CSRF middleware, CORS and SameSite settings.",
  input: "Request data reaching a sink, such as a query, shell, include or browser sink.",
  crypto: "Hashing, HMAC, ciphers, random bytes and key derivation.",
  secrets: "Environment files, keys, credential files and secret-bearing variables.",
  "third-party": "External scripts, iframes, form targets and CSS imports.",
  privacy: "Personal data that is collected, logged or exported.",
  "data-loss": "Schema changes, bulk deletes, uninstall routines and destructive SQL.",
  guardrails: "Pipeline, CI, agent and linter config, dependency manifests and suppressions.",
};

// Every label that the risk-gate applies, with the text a human sees in the label picker.
export function labelDefinitions(): LabelDefinition[] {
  return [
    ...RISKS.map((risk) => ({ name: riskLabel(risk), ...riskStyle[risk] })),
    ...ZONES.map((zone) => ({ name: zoneLabel(zone), color: "5319e7", description: zoneDescriptions[zone] })),
  ];
}
