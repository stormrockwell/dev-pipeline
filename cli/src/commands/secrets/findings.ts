export interface Finding {
  file: string;
  line: number | null;
  rule: string;
  // Prefix and asterisks, never the full value. Null for findings about a path.
  masked: string | null;
  detail: string | null;
  commit: string | null;
  detector: "builtin" | "gitleaks";
}

export type Mode = "staged" | "range" | "stdin";

export function formatText(mode: Mode, findings: Finding[]): string {
  if (findings.length === 0) return `pipeline secrets: clean (${mode})`;
  const lines = findings.map((finding) => {
    const place = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
    const parts = [place, finding.rule];
    if (finding.masked !== null) parts.push(finding.masked);
    if (finding.detail !== null) parts.push(`(${finding.detail})`);
    if (finding.commit !== null) parts.push(`in commit ${finding.commit.slice(0, 8)}`);
    return `  ${parts.join("  ")}`;
  });
  const noun = findings.length === 1 ? "finding" : "findings";
  return [
    `pipeline secrets: ${findings.length} ${noun} (${mode})`,
    ...lines,
    "Remove the value and rotate it if it ever left this machine. Allowlist a test fixture in .pipeline/secrets-allow.",
  ].join("\n");
}

export function formatJson(mode: Mode, findings: Finding[], detectors: string[]): string {
  return JSON.stringify({ mode, ok: findings.length === 0, detectors, findings }, null, 2);
}
