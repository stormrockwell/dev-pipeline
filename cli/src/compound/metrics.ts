import type { GateRecord } from "../commands/gate-record/record.ts";
import type { MergedPr, RepoData } from "./github.ts";
import { fixedPr, revertedPr } from "./quality.ts";

export const TIERS = ["T0", "T1", "T2", "T3"];
// PRs whose record is missing, older than version 2, or holds no tasks.
export const UNTIERED = "untiered";

const DAY = 24 * 60 * 60 * 1000;
const REVERT = /^(revert(\([^)]*\))?!?:|Revert ")/i;

/**
 * A count over the units it was measured on, such as tokens over PRs
 */
export interface Ratio {
  total: number;
  of: number;
}

/**
 * A metric the sources cannot supply, and the reason the page gives in its place
 */
export interface Missing {
  reason: string;
}

/**
 * The review and run side of one PR's version 2 gate record
 */
export interface RecordRow {
  tasks: number;
  rounds: number;
  findings: number;
  capHits: number;
  // Null when no run logs were read for the work.
  run: RunRow | null;
}

/**
 * The run telemetry a record carries for one PR
 */
export interface RunRow {
  tokens: number;
  // Tokens by role, with the main session under "main".
  roles: Record<string, number>;
  // Working time in milliseconds by stage name.
  stages: Record<string, number>;
  waitMs: number;
  waitCount: number;
  retries: { failed: number; retried: number; unchanged: number };
  redirects: number;
}

/**
 * One merged PR's numbers, as the metrics page counts them
 */
export interface PrRow {
  repo: string;
  number: number;
  mergedAt: string;
  tier: string;
  humanComments: number;
  approvals: number;
  // Milliseconds from opening to the first approval, or null without both.
  approvalMs: number | null;
  fixes: number;
  reverted: boolean;
  // Null for a PR without a version 2 record.
  record: RecordRow | null;
}

export interface Retries {
  failed: number;
  retried: number;
  unchanged: number;
  of: number;
}

/**
 * The numbers for a set of PRs, each null or missing where its source is absent
 */
export interface Summary {
  prs: number;
  quality: {
    escaped: Ratio | null;
    fixes: Ratio | null;
    reverts: Ratio | null;
    humanComments: Ratio | null;
    findingsPerRound: Ratio | null;
  };
  attention: {
    approvals: Ratio | null;
    approvalMedianMs: { ms: number; of: number } | null;
    waitMs: Ratio | null;
    waits: Ratio | null;
    workOrderWait: Missing;
    approvalWait: Missing;
  };
  efficiency: {
    tokens: Ratio | null;
    roles: { role: string; tokens: Ratio }[];
    apiCost: Missing;
    stages: { name: string; ms: Ratio }[];
    stageTokens: Missing;
    rounds: Ratio | null;
    capHits: Ratio | null;
    retries: Retries | null;
    redirects: Ratio | null;
  };
}

export interface TierSummary {
  tier: string;
  summary: Summary;
}

/**
 * The overall numbers, and the numbers of each tier within them
 */
export interface Section {
  summary: Summary;
  tiers: TierSummary[];
}

export interface RepoSection extends Section {
  repo: string;
  prs: PrRow[];
}

/**
 * Everything the metrics page shows, as the page's JSON carries it
 */
export interface MetricsReport {
  windowDays: number;
  since: string;
  sources: {
    repos: { repo: string; prs: number; records: number; fetchedAt: string }[];
    mergedFrom: string | null;
    mergedTo: string | null;
  };
  overall: Section;
  repos: RepoSection[];
}

export interface MetricsOptions {
  // Fixes and reverts count against a PR only within this many days of its merge.
  windowDays: number;
  // Only PRs merged at or after this time, in milliseconds since the epoch.
  from: number;
}

/**
 * The highest tier among a record's tasks, or null when the record has none
 */
function tierOf(gate: GateRecord | null): string | null {
  if (gate === null || gate.version < 2) return null;
  const ranks = gate.tasks.map((task) => TIERS.indexOf(task.tier)).filter((rank) => rank >= 0);
  return ranks.length > 0 ? TIERS[Math.max(...ranks)]! : null;
}

/**
 * The run telemetry a version 2 record carries, with roles keyed the way the stats table names them
 */
function runOf(gate: GateRecord): RunRow {
  const roles: Record<string, number> = { main: gate.cost.main.tokens };
  for (const dispatch of gate.cost.dispatches) {
    const role = dispatch.type.replace(/^dev-pipeline:/, "");
    roles[role] = (roles[role] ?? 0) + dispatch.tokens;
  }
  const stages: Record<string, number> = {};
  for (const stage of gate.stages) stages[stage.name] = (stages[stage.name] ?? 0) + stage.ms;
  return {
    tokens: gate.cost.tokens,
    roles,
    stages,
    waitMs: gate.waits.ms,
    waitCount: gate.waits.count,
    retries: gate.retries ? { failed: gate.retries.failed, retried: gate.retries.retried, unchanged: gate.retries.unchanged } : { failed: 0, retried: 0, unchanged: 0 },
    redirects: gate.redirects?.length ?? 0,
  };
}

/**
 * The record side of a PR's row, from a version 2 gate record
 *
 * Zero sessions means no run logs were read for the work, so its telemetry stays null.
 */
function recordOf(gate: GateRecord): RecordRow {
  return {
    tasks: gate.tasks.length,
    rounds: gate.tasks.reduce((sum, task) => sum + task.rounds, 0),
    findings: gate.findings.opened,
    capHits: gate.findings.capHits,
    run: gate.sessions > 0 ? runOf(gate) : null,
  };
}

/**
 * One merged PR's row
 */
function rowOf(repo: string, pr: MergedPr, fixes: number, reverted: boolean): PrRow {
  const opened = pr.opened === null ? NaN : Date.parse(pr.opened);
  const firstApproval = Math.min(...pr.approvals.map((approval) => Date.parse(approval.at)));
  const approvalMs = Number.isFinite(opened) && Number.isFinite(firstApproval) ? Math.max(0, firstApproval - opened) : null;
  const gate = pr.gate !== null && pr.gate.version >= 2 ? pr.gate : null;
  return {
    repo,
    number: pr.number,
    mergedAt: pr.mergedAt,
    tier: tierOf(gate) ?? UNTIERED,
    humanComments: pr.comments.filter((comment) => comment.kind === "human").length,
    approvals: pr.approvals.length,
    approvalMs,
    fixes,
    reverted,
    record: gate === null ? null : recordOf(gate),
  };
}

/**
 * The rows of one repo's PRs, with each PR's fix commits and revert counted the way the quality half counts them
 *
 * A fix counts only within the window after its merge, and a revert only when it lands after the PR merged.
 */
function rowsOf(data: RepoData, windowMs: number): PrRow[] {
  const fixes = new Map<number, number>();
  const reverted = new Set<number>();
  for (const commit of data.commits) {
    if (REVERT.test(commit.subject)) {
      const pr = revertedPr(commit.message, data.repo, data.prs);
      if (pr && Date.parse(commit.at) > Date.parse(pr.mergedAt)) reverted.add(pr.number);
      continue;
    }
    const pr = fixedPr(commit, data.prs, windowMs);
    if (pr) fixes.set(pr.number, (fixes.get(pr.number) ?? 0) + 1);
  }
  return data.prs.map((pr) => rowOf(data.repo, pr, fixes.get(pr.number) ?? 0, reverted.has(pr.number)));
}

/**
 * A ratio, or null when nothing was measured
 */
function ratio(total: number, of: number): Ratio | null {
  return of > 0 ? { total, of } : null;
}

/**
 * The sum of one field over a list
 */
function sum<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

/**
 * The middle of a list of numbers, or the mean of its middle two
 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The numbers for a set of PRs, each one measured over the PRs whose source it needs
 */
export function summarize(rows: PrRow[]): Summary {
  const prs = rows.length;
  const recorded = rows.flatMap((row) => (row.record === null ? [] : [row.record]));
  const runs = recorded.flatMap((record) => (record.run === null ? [] : [record.run]));
  const approvalTimes = rows.flatMap((row) => (row.approvalMs === null ? [] : [row.approvalMs]));

  const roleTotals = new Map<string, number>();
  for (const run of runs) for (const [role, tokens] of Object.entries(run.roles)) roleTotals.set(role, (roleTotals.get(role) ?? 0) + tokens);
  const roles = [...roleTotals]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([role, tokens]) => ({ role, tokens: { total: tokens, of: runs.length } }));

  const stageTotals = new Map<string, Ratio>();
  for (const run of runs) {
    for (const [name, ms] of Object.entries(run.stages)) {
      const entry = stageTotals.get(name) ?? { total: 0, of: 0 };
      entry.total += ms;
      entry.of += 1;
      stageTotals.set(name, entry);
    }
  }

  const retries = runs.length > 0 ? { failed: sum(runs, (run) => run.retries.failed), retried: sum(runs, (run) => run.retries.retried), unchanged: sum(runs, (run) => run.retries.unchanged), of: runs.length } : null;
  const tasks = sum(recorded, (record) => record.tasks);

  return {
    prs,
    quality: {
      escaped: ratio(rows.filter((row) => row.fixes > 0 || row.reverted).length, prs),
      fixes: ratio(sum(rows, (row) => row.fixes), prs),
      reverts: ratio(rows.filter((row) => row.reverted).length, prs),
      humanComments: ratio(sum(rows, (row) => row.humanComments), prs),
      findingsPerRound: ratio(sum(recorded, (record) => record.findings), sum(recorded, (record) => record.rounds)),
    },
    attention: {
      approvals: ratio(sum(rows, (row) => row.approvals), prs),
      approvalMedianMs: approvalTimes.length > 0 ? { ms: median(approvalTimes), of: approvalTimes.length } : null,
      waitMs: ratio(sum(runs, (run) => run.waitMs), runs.length),
      waits: ratio(sum(runs, (run) => run.waitCount), runs.length),
      workOrderWait: { reason: "the record stores one waits total, not a split between the work order and approval" },
      approvalWait: { reason: "the record stores one waits total, not a split between the work order and approval" },
    },
    efficiency: {
      tokens: ratio(sum(runs, (run) => run.tokens), runs.length),
      roles,
      apiCost: { reason: "the CLI carries no price table, so cost is not computed" },
      stages: [...stageTotals].map(([name, ms]) => ({ name, ms })),
      stageTokens: { reason: "the record holds tokens by role, not by stage" },
      rounds: ratio(sum(recorded, (record) => record.rounds), tasks),
      capHits: ratio(sum(recorded, (record) => record.capHits), tasks),
      retries,
      redirects: ratio(sum(runs, (run) => run.redirects), runs.length),
    },
  };
}

/**
 * The overall numbers of a set of PRs, and each tier's within them
 */
function sectionOf(rows: PrRow[]): Section {
  const tiers = [...TIERS, UNTIERED]
    .map((tier) => ({ tier, rows: rows.filter((row) => row.tier === tier) }))
    .filter((group) => group.rows.length > 0)
    .map((group) => ({ tier: group.tier, summary: summarize(group.rows) }));
  return { summary: summarize(rows), tiers };
}

/**
 * The metrics page's numbers for every repo and for all of them together
 *
 * Each source is read only where it exists, so a PR with no version 2 record counts toward the
 * quality and comment numbers but not toward findings, rounds or tokens.
 */
export function metrics(repos: RepoData[], options: MetricsOptions): MetricsReport {
  const windowMs = options.windowDays * DAY;
  const scoped = repos.map((data) => {
    const prs = data.prs.filter((pr) => Date.parse(pr.mergedAt) >= options.from);
    const rows = rowsOf({ ...data, prs }, windowMs);
    return { data, rows };
  });
  const merges = scoped.flatMap((entry) => entry.rows.map((row) => row.mergedAt)).sort();
  return {
    windowDays: options.windowDays,
    since: new Date(options.from).toISOString(),
    sources: {
      repos: scoped.map(({ data, rows }) => ({ repo: data.repo, prs: rows.length, records: rows.filter((row) => row.record !== null).length, fetchedAt: data.fetchedAt })),
      mergedFrom: merges[0] ?? null,
      mergedTo: merges.at(-1) ?? null,
    },
    overall: sectionOf(scoped.flatMap((entry) => entry.rows)),
    repos: scoped.map(({ data, rows }) => ({ repo: data.repo, prs: rows, ...sectionOf(rows) })),
  };
}
