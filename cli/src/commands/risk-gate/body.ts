export type HumanReview =
  | { kind: "missing" }
  | { kind: "none" }
  | { kind: "required"; zones: string[] }
  | { kind: "malformed"; line: string };

function riskSection(body: string): string[] {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^## Risk\s*$/.test(line));
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Reads the `Human review:` line of the Risk section. Full format validation belongs to pr-check. */
export function parseHumanReview(body: string): HumanReview {
  const line = riskSection(body)
    .map((candidate) => candidate.trim())
    .find((candidate) => /^Human review:/i.test(candidate));
  if (line === undefined) return { kind: "missing" };

  const value = line.replace(/^Human review:\s*/i, "");
  if (value === "none.") return { kind: "none" };
  if (!/^required,/.test(value)) return { kind: "malformed", line };

  const zones = [...value.matchAll(/zone:([a-z-]+)/g)].map((match) => match[1]!);
  return zones.length > 0 ? { kind: "required", zones } : { kind: "malformed", line };
}
