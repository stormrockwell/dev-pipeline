import { CONFIG_PATH } from "./config.ts";
import type { FileScan, Match, Zone, ZoneConfig } from "./types.ts";

export type Mode = "tree" | "staged" | "range";

export interface ReportMatch extends Match {
  file: string;
}

export interface FileReport {
  file: string;
  zones: Zone[];
  matchCount: number;
  matches: Match[];
  removed: Match[];
}

export interface Report {
  mode: Mode;
  config: { source: "file" | "builtin"; path: string | null; packs: string[] };
  summary: {
    filesScanned: number;
    filesWithMatches: number;
    matches: number;
    removed: number;
    zones: Partial<Record<Zone, number>>;
  };
  /** Removed lines that matched a signal, which the reviewer reads first. */
  removed: ReportMatch[];
  files: FileReport[];
}

export function buildReport(mode: Mode, config: ZoneConfig, scans: FileScan[]): Report {
  const files: FileReport[] = scans
    .filter((scan) => scan.matches.length > 0 || scan.removed.length > 0)
    .map((scan) => ({
      file: scan.path,
      zones: scan.zones,
      matchCount: scan.matches.length,
      matches: scan.matches,
      removed: scan.removed,
    }))
    .sort((a, b) => a.file.localeCompare(b.file));

  const zones: Partial<Record<Zone, number>> = {};
  for (const file of files) {
    for (const match of [...file.matches, ...file.removed]) zones[match.zone] = (zones[match.zone] ?? 0) + 1;
  }
  const removed = files.flatMap((file) => file.removed.map((match) => ({ file: file.file, ...match })));

  return {
    mode,
    config: { source: config.source, path: config.source === "file" ? CONFIG_PATH : null, packs: config.packs },
    summary: {
      filesScanned: scans.length,
      filesWithMatches: files.length,
      matches: files.reduce((sum, file) => sum + file.matchCount, 0),
      removed: removed.length,
      zones: Object.fromEntries(Object.entries(zones).sort(([a], [b]) => a.localeCompare(b))),
    },
    removed,
    files,
  };
}

function where(match: Match): string {
  return match.line === null ? "path rule" : `line ${match.line}`;
}

export function formatText(report: Report): string {
  const out: string[] = [];
  const source = report.config.source === "file" ? report.config.path : "built-in packs";
  const packs = report.config.packs.length > 0 ? ` (${report.config.packs.join(", ")})` : "";
  out.push(`Zone scan (${report.mode}) using ${source}${packs}.`);

  if (report.removed.length > 0) {
    out.push("", "Weakened controls, removed lines that matched a signal:");
    for (const match of report.removed) {
      out.push(`  ${match.file}:${match.line} [${match.zone}] removed: ${match.text}`);
    }
  }

  if (report.files.length > 0) {
    out.push("", "Files in human review zones:");
    for (const file of report.files) {
      out.push(`  ${file.file}  [${file.zones.join(", ")}]  ${file.matchCount} match${file.matchCount === 1 ? "" : "es"}`);
      for (const match of file.matches) {
        const detail = match.kind === "path" ? `matches ${match.pattern}` : match.text;
        out.push(`    ${where(match)} [${match.zone}] ${detail}`);
      }
    }
  }

  const { summary } = report;
  const zoneList = Object.entries(summary.zones).map(([zone, count]) => `${zone}: ${count}`).join(", ");
  out.push(
    "",
    `${summary.filesScanned} files scanned, ${summary.filesWithMatches} in zones, ${summary.matches} matches, ${summary.removed} removed signals${zoneList ? ` (${zoneList})` : ""}.`,
  );
  return out.join("\n");
}

export function formatJson(report: Report): string {
  return JSON.stringify(report, null, 2);
}
