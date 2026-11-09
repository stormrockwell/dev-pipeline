import type { FileChange } from "./diff.ts";
import type { Finding } from "./findings.ts";
import { maskValue, scanLine } from "./patterns.ts";
import { sensitivePath, skipsEntropy } from "./sensitive.ts";

export function scanPath(path: string, commit: string | null = null): Finding[] {
  const verdict = sensitivePath(path);
  if (!verdict) return [];
  return [
    { file: path, line: null, rule: "sensitive-file", masked: null, detail: verdict.detail, commit, detector: "builtin" },
  ];
}

export function scanLines(
  path: string,
  lines: { line: number; text: string }[],
  commit: string | null = null,
): Finding[] {
  const entropy = !skipsEntropy(path);
  const findings: Finding[] = [];
  for (const { line, text } of lines) {
    for (const match of scanLine(text, { entropy })) {
      findings.push({
        file: path,
        line,
        rule: match.rule,
        masked: maskValue(match.value),
        detail: null,
        commit,
        detector: "builtin",
      });
    }
  }
  return findings;
}

export function scanText(path: string, text: string): Finding[] {
  const lines = text.split("\n").map((line, index) => ({ line: index + 1, text: line }));
  return [...scanPath(path), ...scanLines(path, lines)];
}

export function scanChanges(changes: FileChange[], allowed: (path: string) => boolean): Finding[] {
  const findings: Finding[] = [];
  for (const change of changes) {
    if (change.deleted || allowed(change.path)) continue;
    findings.push(...scanPath(change.path, change.commit), ...scanLines(change.path, change.added, change.commit));
  }
  return findings;
}
