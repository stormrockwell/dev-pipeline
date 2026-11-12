import type { Missing, MetricsReport, PrRow, Ratio, RepoSection, Section, Summary, TierSummary } from "./metrics.ts";

const NO_DATA = "no data";
const RUN_LOGS = " with run logs";

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f6f6f3;
  --panel: #ffffff;
  --fg: #1c1c1a;
  --muted: #5f5e58;
  --line: #d9d8d1;
  --accent: #2c5f8d;
  --nodata: #8b8a82;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151514;
    --panel: #1f1f1d;
    --fg: #e9e8e2;
    --muted: #a6a59c;
    --line: #3a3a36;
    --accent: #8db8e4;
    --nodata: #7d7c75;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.6rem; margin: 0 0 4px; }
h2 { font-size: 1.25rem; margin: 40px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
h3 { font-size: 1rem; margin: 24px 0 8px; color: var(--accent); }
p.meta, .muted { color: var(--muted); margin: 0 0 12px; }
nav.jump { display: flex; flex-wrap: wrap; gap: 8px 14px; margin: 16px 0 0; }
nav.jump a { color: var(--accent); }
.table-wrap { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
thead th { color: var(--muted); font-weight: 600; white-space: nowrap; }
tbody th { font-weight: 500; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.value { font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 600; }
.nodata { color: var(--nodata); font-style: italic; font-weight: 400; }
td.basis { color: var(--muted); }
details { margin-top: 16px; }
summary { cursor: pointer; color: var(--accent); }
footer { margin-top: 48px; color: var(--muted); font-size: 13px; }
`;

/**
 * Escapes text for an HTML element or a double-quoted attribute
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * A count with its thousands or millions shortened
 */
function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(count);
}

/**
 * A decimal shown as a whole number when it is one, or with one decimal place
 */
function decimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * A duration as minutes and seconds, or hours and minutes past an hour
 */
function clock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * A count with its noun in the singular or plural
 */
function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * A ratio's per-unit value, or the no data text when nothing was measured
 */
function perUnit(ratio: Ratio | null, format: (value: number) => string): string {
  return ratio === null ? NO_DATA : format(ratio.total / ratio.of);
}

/**
 * The basis line under a per-unit value, such as "5 over 2 PRs with run logs"
 */
function basisOf(ratio: Ratio | null, format: (value: number) => string, unit: string, suffix = ""): string {
  return ratio === null ? "" : `${format(ratio.total)} over ${plural(ratio.of, unit)}${suffix}`;
}

/**
 * A percentage of a ratio, or the no data text
 */
function percent(ratio: Ratio | null): string {
  return ratio === null ? NO_DATA : `${Math.round((100 * ratio.total) / ratio.of)}%`;
}

/**
 * The basis of a percentage, such as "2 of 5 PRs"
 */
function percentBasis(ratio: Ratio | null): string {
  return ratio === null ? "" : `${ratio.total} of ${plural(ratio.of, "PR")}`;
}

/**
 * A metric row in a metrics table, with its value marked when it has no data
 */
function metricRow(label: string, value: string, basis: string): string {
  const missing = value === NO_DATA;
  return `<tr><th scope="row">${escapeHtml(label)}</th><td class="${missing ? "value nodata" : "value"}">${escapeHtml(value)}</td><td class="basis">${escapeHtml(basis)}</td></tr>`;
}

/**
 * A metric row for a source the record cannot supply, with the reason in place of a basis
 */
function missingRow(label: string, missing: Missing): string {
  return metricRow(label, NO_DATA, missing.reason);
}

/**
 * The quality metrics of a summary as table rows
 */
function qualityRows(summary: Summary): string {
  const q = summary.quality;
  return [
    metricRow("PRs with an escaped defect", percent(q.escaped), percentBasis(q.escaped)),
    metricRow("Fix commits per PR", perUnit(q.fixes, decimal), basisOf(q.fixes, decimal, "PR")),
    metricRow("PRs reverted", percent(q.reverts), percentBasis(q.reverts)),
    metricRow("Human review comments per PR", perUnit(q.humanComments, decimal), basisOf(q.humanComments, decimal, "PR")),
    metricRow("Findings opened per review round", perUnit(q.findingsPerRound, decimal), basisOf(q.findingsPerRound, decimal, "round")),
  ].join("");
}

/**
 * The human attention metrics of a summary as table rows
 */
function attentionRows(summary: Summary): string {
  const a = summary.attention;
  const median = a.approvalMedianMs;
  return [
    metricRow("Approvals per PR", perUnit(a.approvals, decimal), basisOf(a.approvals, decimal, "PR")),
    metricRow("Median time from opening to first approval", median === null ? NO_DATA : clock(median.ms), median === null ? "" : `over ${plural(median.of, "PR")}`),
    metricRow("Waiting on a person, per PR", a.waitMs === null ? NO_DATA : clock(a.waitMs.total / a.waitMs.of), a.waitMs === null ? "" : `over ${plural(a.waitMs.of, "PR")}${RUN_LOGS}`),
    metricRow("Waits per PR", perUnit(a.waits, decimal), a.waits === null ? "" : `over ${plural(a.waits.of, "PR")}${RUN_LOGS}`),
    missingRow("Waiting on the work order, per PR", a.workOrderWait),
    missingRow("Waiting on approval, per PR", a.approvalWait),
  ].join("");
}

/**
 * The efficiency metrics of a summary as table rows
 */
function efficiencyRows(summary: Summary): string {
  const e = summary.efficiency;
  const rows = [
    metricRow("Tokens per PR", perUnit(e.tokens, tokens), basisOf(e.tokens, tokens, "PR", RUN_LOGS)),
    ...e.roles.map((entry) => metricRow(`Tokens per PR, ${entry.role}`, perUnit(entry.tokens, tokens), basisOf(entry.tokens, tokens, "PR", RUN_LOGS))),
    missingRow("API-priced cost per PR", e.apiCost),
    ...e.stages.map((stage) => metricRow(`Time in ${stage.name}, per PR`, clock(stage.ms.total / stage.ms.of), `over ${plural(stage.ms.of, "PR")}${RUN_LOGS}`)),
    missingRow("Tokens per stage", e.stageTokens),
    metricRow("Review rounds per task", perUnit(e.rounds, decimal), basisOf(e.rounds, decimal, "task")),
    metricRow("Round cap hits per task", perUnit(e.capHits, decimal), basisOf(e.capHits, decimal, "task")),
    metricRow(
      "Failed commands",
      e.retries === null ? NO_DATA : String(e.retries.failed),
      e.retries === null ? "" : `${e.retries.retried} retried, ${e.retries.unchanged} passed unchanged, over ${plural(e.retries.of, "PR")}${RUN_LOGS}`,
    ),
    metricRow("Redirects per PR", perUnit(e.redirects, decimal), basisOf(e.redirects, decimal, "PR", RUN_LOGS)),
  ];
  return rows.join("");
}

/**
 * A metrics table with a header row and the given body rows
 */
function metricTable(body: string): string {
  return `<div class="table-wrap"><table><thead><tr><th scope="col">Metric</th><th scope="col" class="num">Value</th><th scope="col">Basis</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

/**
 * A row of cells, the first as a row header and the rest right aligned
 */
function cellRow(cells: string[]): string {
  return `<tr>${cells.map((cell, index) => (index === 0 ? `<th scope="row">${escapeHtml(cell)}</th>` : `<td class="num">${escapeHtml(cell)}</td>`)).join("")}</tr>`;
}

/**
 * A header row of cells, the first left aligned and the rest right aligned
 */
function headRow(names: string[]): string {
  return `<tr>${names.map((name, index) => (index === 0 ? `<th scope="col">${escapeHtml(name)}</th>` : `<th scope="col" class="num">${escapeHtml(name)}</th>`)).join("")}</tr>`;
}

/**
 * One tier's row of the tier table
 */
function tierRow(entry: TierSummary): string {
  const s = entry.summary;
  const cells = [
    entry.tier,
    String(s.prs),
    percent(s.quality.escaped),
    perUnit(s.quality.humanComments, decimal),
    perUnit(s.attention.approvals, decimal),
    s.attention.approvalMedianMs === null ? NO_DATA : clock(s.attention.approvalMedianMs.ms),
    perUnit(s.quality.findingsPerRound, decimal),
    perUnit(s.efficiency.tokens, tokens),
    perUnit(s.efficiency.rounds, decimal),
    s.attention.waitMs === null ? NO_DATA : clock(s.attention.waitMs.total / s.attention.waitMs.of),
  ];
  return cellRow(cells);
}

/**
 * The tier table, one row per tier that has PRs
 */
function tierTable(tiers: TierSummary[]): string {
  const head = ["Tier", "PRs", "Escaped", "Comments per PR", "Approvals per PR", "Median approval", "Findings per round", "Tokens per PR", "Rounds per task", "Waiting per PR"];
  const body = tiers.length > 0 ? tiers.map(tierRow).join("") : `<tr><td colspan="${head.length}" class="nodata">${NO_DATA}</td></tr>`;
  return `<h3>By tier</h3><div class="table-wrap"><table><thead>${headRow(head)}</thead><tbody>${body}</tbody></table></div>`;
}

/**
 * A number cell for a per PR value that may be missing
 */
function cellOf(value: number | null, format: (value: number) => string): string {
  return value === null ? NO_DATA : format(value);
}

/**
 * One merged PR's row of the PR table
 */
function prRow(row: PrRow): string {
  const record = row.record;
  const run = record?.run ?? null;
  const cells = [
    `#${row.number}`,
    row.tier,
    row.mergedAt.slice(0, 10),
    String(row.humanComments),
    String(row.approvals),
    String(row.fixes),
    row.reverted ? "yes" : "no",
    record === null ? NO_DATA : `${record.findings}`,
    record === null ? NO_DATA : `${record.rounds}`,
    cellOf(run?.tokens ?? null, tokens),
    cellOf(run?.waitMs ?? null, clock),
  ];
  return cellRow(cells);
}

/**
 * The PR table of one repo, folded away because it runs long
 */
function prTable(prs: PrRow[]): string {
  const head = ["PR", "Tier", "Merged", "Comments", "Approvals", "Fixes", "Reverted", "Findings", "Rounds", "Tokens", "Waiting"];
  const body = prs.length > 0 ? prs.map(prRow).join("") : `<tr><td colspan="${head.length}" class="nodata">${NO_DATA}</td></tr>`;
  return `<details><summary>${prs.length} merged PRs</summary><div class="table-wrap"><table><thead>${headRow(head)}</thead><tbody>${body}</tbody></table></div></details>`;
}

/**
 * The numbers of one section, for a repo or for all repos together
 */
function sectionHtml(id: string, title: string, section: Section, prs: PrRow[] | null): string {
  const s = section.summary;
  const body = [
    `<h2 id="${escapeHtml(id)}">${escapeHtml(title)}</h2>`,
    `<p class="meta">${plural(s.prs, "merged PR")}</p>`,
    `<h3>Quality</h3>`,
    metricTable(qualityRows(s)),
    `<h3>Human attention</h3>`,
    metricTable(attentionRows(s)),
    `<h3>Efficiency</h3>`,
    metricTable(efficiencyRows(s)),
    tierTable(section.tiers),
  ];
  if (prs !== null) body.push(prTable(prs));
  return `<section>${body.join("")}</section>`;
}

/**
 * The sources table, with one row per repo
 */
function sourcesHtml(report: MetricsReport): string {
  const rows = report.sources.repos
    .map((repo) => `<tr><th scope="row">${escapeHtml(repo.repo)}</th><td class="num">${repo.prs}</td><td class="num">${repo.records}</td><td>${escapeHtml(repo.fetchedAt.slice(0, 16).replace("T", " "))} UTC</td></tr>`)
    .join("");
  const merged = report.sources.mergedFrom === null ? "No PRs merged in the window." : `Merged ${escapeHtml(report.sources.mergedFrom.slice(0, 10))} to ${escapeHtml(report.sources.mergedTo!.slice(0, 10))}.`;
  return [
    `<h2>Sources</h2>`,
    `<p class="meta">${merged} Fixes count against a PR within ${plural(report.windowDays, "day")} of its merge, and only PRs merged on or after ${escapeHtml(report.since.slice(0, 10))} are counted.</p>`,
    `<div class="table-wrap"><table><thead><tr><th scope="col">Repo</th><th scope="col" class="num">Merged PRs</th><th scope="col" class="num">With a version 2 record</th><th scope="col">Fetched</th></tr></thead><tbody>${rows}</tbody></table></div>`,
  ].join("");
}

/**
 * The page's HTML, a self-contained file that reads offline in light and dark
 *
 * Every value from GitHub or a record goes through escapeHtml, so a repo or stage name cannot break the page.
 */
export function renderMetricsHtml(report: MetricsReport, generatedAt: string): string {
  const repoLinks = report.repos.map((repo, index) => `<a href="#repo-${index}">${escapeHtml(repo.repo)}</a>`).join("");
  const sections = [
    sectionHtml("overall", "All repos", report.overall, null),
    ...report.repos.map((repo: RepoSection, index) => sectionHtml(`repo-${index}`, repo.repo, repo, repo.prs)),
  ].join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Compounder metrics</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
<h1>Compounder metrics</h1>
<p class="meta">Generated ${escapeHtml(generatedAt)}. Quality, human attention and efficiency, from each repo's merged PRs and their gate records.</p>
<nav class="jump"><a href="#overall">All repos</a>${repoLinks}</nav>
</header>
${sourcesHtml(report)}
${sections}
<footer>Cost is shown as no data because the CLI has no price table. Tokens stand in for it.</footer>
</main>
</body>
</html>
`;
}
