export const ZONES = [
  "auth",
  "authz",
  "csrf",
  "input",
  "crypto",
  "secrets",
  "third-party",
  "privacy",
  "data-loss",
  "guardrails",
] as const;

export type Zone = (typeof ZONES)[number];

/** Signal groups name the file types a signal applies to. */
export const GROUPS = ["php", "js", "markup", "css", "sql", "suppressions"] as const;

export type Group = (typeof GROUPS)[number];

export interface PathRule {
  glob: string;
  zone: Zone;
}

export interface Signal {
  group: Group;
  pattern: string;
  zone: Zone;
  /** The signal counts only when this pattern also matches in the same function or hunk. */
  near?: string;
  /** The signal counts only on removed lines, because adding the same text is the safe direction. */
  only?: "removed";
  flags?: string;
}

/** A parsed and validated sensitive.yml, or the built-in packs when a repo has none. */
export interface ZoneConfig {
  source: "file" | "builtin";
  packs: string[];
  paths: PathRule[];
  signals: Signal[];
  /** Globs of designated paths, where a T3 change needs two approvals. */
  critical: string[];
}

export interface RemovedLine {
  /** The line number in the old file. */
  line: number;
  text: string;
}

export interface FileInput {
  path: string;
  /** The new content, or null when the file is deleted, binary or unreadable. */
  content: string | null;
  /** The new line numbers that a change added, or null when every line counts. */
  added: Set<number> | null;
  removed: RemovedLine[];
  deleted: boolean;
}

export interface Match {
  kind: "path" | "signal";
  zone: Zone;
  /** Null for a path rule, which matches the whole file. */
  line: number | null;
  pattern: string;
  text: string;
}

export interface FileScan {
  path: string;
  zones: Zone[];
  matches: Match[];
  /** Removed lines that matched a signal, which weaken a control. */
  removed: Match[];
}
