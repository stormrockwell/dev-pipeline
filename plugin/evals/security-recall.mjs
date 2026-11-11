#!/usr/bin/env node
/**
 * Scores the planted vulnerability suite from one or more aggregate-result.json files
 *
 * Each hole grader is named hole-<zone>-<n>, and it passes when the verified finding for that
 * hole reached the round's fix list. A clean control counts as a false alarm in each run where
 * its no-security-finding grader failed.
 *
 * Usage: node plugin/evals/security-recall.mjs <aggregate-result.json>...
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOLE = /^hole-([a-z-]+)-\d+$/;

/**
 * Tallies holes per zone and clean control false alarms across parsed aggregate results
 */
export function recall(results) {
  const zones = {};
  const missed = [];
  const clean = { runs: 0, falseAlarms: 0, cases: [] };
  for (const result of results) {
    for (const item of result.cases ?? []) {
      for (const run of item.arms?.with ?? []) {
        for (const grader of run.graders ?? []) {
          const hole = HOLE.exec(grader.name);
          if (hole) {
            const zone = (zones[hole[1]] ??= { found: 0, total: 0 });
            zone.total += 1;
            if (grader.passed) zone.found += 1;
            else missed.push(`${item.name} ${grader.name}`);
          } else if (grader.name === "no-security-finding") {
            clean.runs += 1;
            if (!grader.passed) {
              clean.falseAlarms += 1;
              clean.cases.push(item.name);
            }
          }
        }
      }
    }
  }
  const found = Object.values(zones).reduce((sum, zone) => sum + zone.found, 0);
  const total = Object.values(zones).reduce((sum, zone) => sum + zone.total, 0);
  return { zones, found, total, recall: total === 0 ? null : found / total, missed, clean };
}

/**
 * Formats a ratio as a whole percent
 */
function percent(found, total) {
  return total === 0 ? "n/a" : `${Math.round((found / total) * 100)}%`;
}

/**
 * Renders the recall report as text
 */
export function render(report) {
  const lines = ["zone          found  total  recall"];
  for (const zone of Object.keys(report.zones).sort()) {
    const { found, total } = report.zones[zone];
    lines.push(`${zone.padEnd(13)} ${String(found).padStart(5)}  ${String(total).padStart(5)}  ${percent(found, total).padStart(6)}`);
  }
  lines.push("", `overall recall: ${report.found}/${report.total} (${percent(report.found, report.total)})`);
  lines.push(`clean control false alarms: ${report.clean.falseAlarms}/${report.clean.runs}${report.clean.cases.length > 0 ? ` (${report.clean.cases.join(", ")})` : ""}`);
  if (report.missed.length > 0) lines.push("", "missed:", ...report.missed.map((line) => `  ${line}`));
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("Usage: node plugin/evals/security-recall.mjs <aggregate-result.json>...");
    process.exit(2);
  }
  console.log(render(recall(paths.map((path) => JSON.parse(readFileSync(path, "utf8"))))));
}
