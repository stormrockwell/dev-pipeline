import type { GateRecord } from "../../src/commands/gate-record/record.ts";
import { type Comment, type MergedPr, type RepoData, summarizeRecord, type Touch } from "../../src/compound/github.ts";

export const SAVE = "includes/class-save.php";
export const CART = "includes/class-cart.php";
export const PRICES = "src/prices.js";
export const BUILD = "src/build.js";
export const DOCS = "docs/a.md";

// The window the fixtures cover starts on the first of November, and every time below is in UTC.
export const SINCE = "2026-11-01T00:00:00Z";

/**
 * The zones a fixture file falls in, with the input zone on the save handler
 */
function touches(paths: string[]): Touch[] {
  return paths.map((path) => ({ path, zones: path === SAVE ? ["input"] : [] }));
}

interface RunSpec {
  main: number;
  sessions?: number;
  dispatches: [type: string, task: string, tokens: number][];
  stages: [name: string, ms: number][];
  waits: [count: number, ms: number];
  retries?: { failed: number; retried: number; unchanged: number };
  redirects?: string[][];
}

interface RecordSpec {
  tasks: [id: string, tier: string][];
  // One entry per review round, with the task it ran on and the findings it opened.
  reviewRounds: [task: string, opened: number][];
  capHits?: number;
  run?: RunSpec;
}

/**
 * A version 2 gate record of the fixture work, built from the parts a test varies
 */
export function gateOf(spec: RecordSpec): GateRecord {
  const run = spec.run;
  const dispatchTokens = run ? run.dispatches.reduce((sum, [, , tokens]) => sum + tokens, 0) : 0;
  const main = run?.main ?? 0;
  const rounds = spec.reviewRounds.map(([task, opened], index) => ({ task, round: index + 1, scope: "full" as const, opened, fixed: opened }));
  return {
    version: 2,
    work: "fixture-work",
    title: "Fixture work",
    pr: null,
    tasks: spec.tasks.map(([id, tier]) => ({
      id,
      title: `Task ${id}`,
      tier,
      zones: tier === "T3" ? ["input"] : [],
      status: null,
      branch: null,
      commits: null,
      rounds: spec.reviewRounds.filter(([task]) => task === id).length,
    })),
    gates: [],
    accepted: [],
    findings: {
      opened: spec.reviewRounds.reduce((sum, [, opened]) => sum + opened, 0),
      fixed: spec.reviewRounds.reduce((sum, [, opened]) => sum + opened, 0),
      accepted: 0,
      overruled: 0,
      capHits: spec.capHits ?? 0,
    },
    rulings: [],
    cost: {
      tokens: main + dispatchTokens,
      main: { model: run ? "claude-opus-4-7" : null, turns: 4, tokens: main },
      dispatches: run ? run.dispatches.map(([type, task, tokens]) => ({ type, model: "claude-sonnet-4-6", task, turns: 3, tokens })) : [],
    },
    stages: run ? run.stages.map(([name, ms]) => ({ name, ms })) : [],
    waits: run ? { count: run.waits[0], ms: run.waits[1] } : { count: 0, ms: 0 },
    sessions: run ? (run.sessions ?? 2) : 0,
    pipeline: "0.9.0",
    ...(rounds.length > 0 ? { rounds } : {}),
    ...(run?.retries ? { retries: { failed: run.retries.failed, retried: run.retries.retried, unchanged: run.retries.unchanged } } : {}),
    ...(run?.redirects ? { redirects: run.redirects } : {}),
  };
}

/**
 * A human review comment on a PR, on the save handler unless another path is given
 */
function human(author: string, at: string, path: string | null = SAVE): Comment {
  return { author, kind: "human", body: "Please check this.", path, zones: path === SAVE ? ["input"] : [], at };
}

/**
 * A merged PR of the fixture shop or blog
 */
function pr(number: number, fields: Partial<MergedPr> & Pick<MergedPr, "mergedAt" | "files">): MergedPr {
  return {
    number,
    title: `feat: change ${number}`,
    author: "dana",
    opened: null,
    mergeSha: `m${number}`,
    base: "main",
    comments: [],
    approvals: [],
    record: null,
    gate: null,
    ...fields,
  };
}

/**
 * A v1 record, which the metrics page reads for escapes and comments but not for rounds or tokens
 */
const OLD_RECORD = { version: 1, work: "old", tasks: [{ id: "1", tier: "T1", zones: [] }], gates: [], findings: { opened: 1, fixed: 1, accepted: 0 } } as unknown as GateRecord;

/**
 * Two pilot repos of fixture PRs, with every number the metrics tests check worked out by hand
 */
export function pilotRepos(): RepoData[] {
  const shopGates = {
    one: gateOf({ tasks: [["1", "T1"]], reviewRounds: [["1", 2]], run: { main: 30000, dispatches: [["dev-pipeline:implementer", "1", 20000]], stages: [["spec", 600000], ["build", 1200000]], waits: [1, 300000] } }),
    two: gateOf({
      tasks: [["2", "T2"], ["3", "T3"]],
      reviewRounds: [["2", 3], ["2", 1], ["3", 1]],
      capHits: 1,
      run: {
        main: 40000,
        dispatches: [["dev-pipeline:implementer", "2", 30000], ["dev-pipeline:reviewer", "3", 10000]],
        stages: [["build", 3600000]],
        waits: [2, 900000],
        retries: { failed: 2, retried: 1, unchanged: 1 },
        redirects: [["quick", "full"]],
      },
    }),
    four: gateOf({ tasks: [["4", "T0"]], reviewRounds: [] }),
  };
  const shop: RepoData = {
    version: 2,
    repo: "example/shop",
    fetchedAt: "2026-11-20T08:00:00Z",
    since: SINCE,
    prs: [
      pr(1, {
        opened: "2026-11-01T09:00:00Z",
        mergedAt: "2026-11-01T12:00:00Z",
        files: touches([SAVE]),
        comments: [human("riley", "2026-11-01T10:30:00Z")],
        approvals: [{ by: "riley", at: "2026-11-01T11:00:00Z" }],
        record: summarizeRecord(shopGates.one),
        gate: shopGates.one,
      }),
      pr(2, {
        opened: "2026-11-03T09:00:00Z",
        mergedAt: "2026-11-03T12:00:00Z",
        files: touches([CART]),
        comments: [human("riley", "2026-11-03T10:00:00Z", CART), human("riley", "2026-11-03T11:00:00Z", CART), { author: "copilot[bot]", kind: "agent", body: null, path: null, zones: [], at: "2026-11-03T10:05:00Z" }],
        approvals: [
          { by: "riley", at: "2026-11-03T15:00:00Z" },
          { by: "sam", at: "2026-11-03T16:00:00Z" },
        ],
        record: summarizeRecord(shopGates.two),
        gate: shopGates.two,
      }),
      pr(3, {
        opened: "2026-11-04T07:00:00Z",
        mergedAt: "2026-11-04T08:00:00Z",
        files: touches([PRICES]),
        comments: [human("riley", "2026-11-04T09:00:00Z", PRICES), human("riley", "2026-11-04T09:30:00Z", PRICES)],
        record: summarizeRecord(OLD_RECORD),
        gate: OLD_RECORD,
      }),
      pr(4, { opened: "2026-11-05T07:00:00Z", mergedAt: "2026-11-05T08:00:00Z", files: touches([DOCS]), record: summarizeRecord(shopGates.four), gate: shopGates.four }),
    ],
    commits: [
      { sha: "f1", subject: "fix(save): check the nonce", message: "fix(save): check the nonce", at: "2026-11-04T10:00:00Z", files: touches([SAVE]) },
      { sha: "f2", subject: "fix(prices): round the total", message: "fix(prices): round the total", at: "2026-11-04T11:00:00Z", files: touches([PRICES]) },
      { sha: "r1", subject: 'Revert "feat: change 2"', message: 'Revert "feat: change 2"\n\nThis reverts commit m2.', at: "2026-11-05T12:00:00Z", files: touches([CART]) },
    ],
  };

  const blogGates = {
    seven: gateOf({
      tasks: [["7", "T0"]],
      reviewRounds: [],
      run: { main: 9000, dispatches: [["dev-pipeline:implementer", "7", 6000]], stages: [["build <i>", 400000]], waits: [0, 0] },
    }),
  };
  const blog: RepoData = {
    version: 2,
    repo: "example/blog",
    fetchedAt: "2026-11-20T08:00:00Z",
    since: SINCE,
    prs: [
      pr(7, {
        opened: "2026-11-05T08:00:00Z",
        mergedAt: "2026-11-06T10:00:00Z",
        files: touches([BUILD]),
        approvals: [{ by: "sam", at: "2026-11-05T10:00:00Z" }],
        record: summarizeRecord(blogGates.seven),
        gate: blogGates.seven,
      }),
      pr(8, { opened: "2026-11-01T09:00:00Z", mergedAt: "2026-11-02T09:00:00Z", files: touches([DOCS]), comments: [human("sam", "2026-11-01T12:00:00Z", DOCS)] }),
    ],
    commits: [{ sha: "b1", subject: "fix(build): trim the title", message: "fix(build): trim the title", at: "2026-11-09T09:00:00Z", files: touches([BUILD]) }],
  };
  return [shop, blog];
}
