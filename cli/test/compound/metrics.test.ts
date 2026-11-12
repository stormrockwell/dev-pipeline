import { describe, expect, it } from "vitest";
import { metrics, UNTIERED } from "../../src/compound/metrics.ts";
import { escapeHtml, renderMetricsHtml } from "../../src/compound/metrics-html.ts";
import { pilotRepos, SINCE } from "./metrics-fixtures.ts";

const HOUR = 60 * 60 * 1000;
const from = Date.parse(SINCE);
const options = { windowDays: 14, from };

/**
 * The fixture report with the default window
 */
function report() {
  return metrics(pilotRepos(), options);
}

describe("metrics per PR", () => {
  it("attributes fixes, reverts, comments and approvals to each PR the way the quality half does", () => {
    const shop = report().repos.find((repo) => repo.repo === "example/shop")!;
    const rows = Object.fromEntries(shop.prs.map((row) => [row.number, row]));
    expect(rows[1]).toMatchObject({ tier: "T1", humanComments: 1, approvals: 1, approvalMs: 2 * HOUR, fixes: 1, reverted: false });
    expect(rows[2]).toMatchObject({ tier: "T3", humanComments: 2, approvals: 2, approvalMs: 6 * HOUR, fixes: 0, reverted: true });
    expect(rows[3]).toMatchObject({ tier: UNTIERED, humanComments: 2, approvals: 0, approvalMs: null, fixes: 1, reverted: false, record: null });
    expect(rows[4]).toMatchObject({ tier: "T0", humanComments: 0, record: { tasks: 1, rounds: 0, capHits: 0, run: null } });
  });

  it("tiers each PR by its highest task tier, and groups PRs without a version 2 record as untiered", () => {
    const shop = report().repos.find((repo) => repo.repo === "example/shop")!;
    expect(shop.tiers.map((entry) => entry.tier)).toEqual(["T0", "T1", "T3", UNTIERED]);
  });
});

describe("metrics per source", () => {
  it("reads quality ratios over the PRs, and findings over the rounds of version 2 records", () => {
    const { summary } = report().repos[0]!;
    expect(summary.prs).toBe(4);
    expect(summary.quality.escaped).toEqual({ total: 3, of: 4 });
    expect(summary.quality.fixes).toEqual({ total: 2, of: 4 });
    expect(summary.quality.reverts).toEqual({ total: 1, of: 4 });
    expect(summary.quality.humanComments).toEqual({ total: 5, of: 4 });
    expect(summary.quality.findingsPerRound).toEqual({ total: 7, of: 4 });
    expect(summary.efficiency.rounds).toEqual({ total: 4, of: 4 });
    expect(summary.efficiency.capHits).toEqual({ total: 1, of: 4 });
  });

  it("reads approvals and the median time to the first one", () => {
    const { summary } = report().repos[0]!;
    expect(summary.attention.approvals).toEqual({ total: 3, of: 4 });
    expect(summary.attention.approvalMedianMs).toEqual({ ms: 4 * HOUR, of: 2 });
  });

  it("reads tokens, roles, stages, waits, retries and redirects only from PRs whose work had run logs", () => {
    const { summary } = report().repos[0]!;
    expect(summary.efficiency.tokens).toEqual({ total: 130000, of: 2 });
    expect(summary.efficiency.roles).toEqual([
      { role: "main", tokens: { total: 70000, of: 2 } },
      { role: "implementer", tokens: { total: 50000, of: 2 } },
      { role: "reviewer", tokens: { total: 10000, of: 2 } },
    ]);
    expect(summary.efficiency.stages).toEqual([
      { name: "spec", ms: { total: 600000, of: 1 } },
      { name: "build", ms: { total: 4800000, of: 2 } },
    ]);
    expect(summary.efficiency.retries).toEqual({ failed: 2, retried: 1, unchanged: 1, of: 2 });
    expect(summary.efficiency.redirects).toEqual({ total: 1, of: 2 });
    expect(summary.attention.waitMs).toEqual({ total: 1200000, of: 2 });
    expect(summary.attention.waits).toEqual({ total: 3, of: 2 });
  });

  it("reports missing sources as no data, with the reason where the record cannot supply one", () => {
    const [, blog] = pilotRepos();
    const only = metrics([{ ...blog!, prs: [blog!.prs[1]!], commits: [] }], options);
    const { summary } = only.overall;
    expect(summary.quality.findingsPerRound).toBeNull();
    expect(summary.quality.escaped).toEqual({ total: 0, of: 1 });
    expect(summary.attention.approvalMedianMs).toBeNull();
    expect(summary.attention.waitMs).toBeNull();
    expect(summary.efficiency.tokens).toBeNull();
    expect(summary.efficiency.roles).toEqual([]);
    expect(summary.efficiency.retries).toBeNull();
    expect(summary.efficiency.rounds).toBeNull();
    expect(summary.efficiency.apiCost.reason).toContain("price table");
    expect(summary.efficiency.stageTokens.reason).toContain("by stage");
    expect(summary.attention.workOrderWait.reason).toContain("one waits total");
  });
});

describe("metrics windows and totals", () => {
  it("counts only PRs merged on or after the start", () => {
    const late = metrics(pilotRepos(), { windowDays: 14, from: Date.parse("2026-11-03T00:00:00Z") });
    const shop = late.repos[0]!;
    expect(shop.summary.prs).toBe(3);
    // PR 1 is out of range, so the fix that landed on its files has no PR to count against.
    expect(shop.summary.quality.escaped).toEqual({ total: 2, of: 3 });
  });

  it("counts a fix only within the window after the merge", () => {
    const narrow = metrics(pilotRepos(), { windowDays: 1, from });
    const shop = narrow.repos[0]!;
    expect(shop.prs.find((row) => row.number === 1)!.fixes).toBe(0);
    expect(shop.summary.quality.escaped).toEqual({ total: 2, of: 4 });
  });

  it("pools every repo into the overall section", () => {
    const page = report();
    expect(page.overall.summary.prs).toBe(6);
    expect(page.overall.summary.quality.escaped).toEqual({ total: 4, of: 6 });
    expect(page.sources.repos.map((repo) => [repo.repo, repo.prs, repo.records])).toEqual([
      ["example/shop", 4, 3],
      ["example/blog", 2, 1],
    ]);
    expect(page.sources.mergedFrom).toBe("2026-11-01T12:00:00Z");
    expect(page.sources.mergedTo).toBe("2026-11-06T10:00:00Z");
  });
});

describe("the metrics page", () => {
  it("is one self-contained document with no external resource and no CSS comment", () => {
    const html = renderMetricsHtml(report(), "2026-11-20 08:00 UTC");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/@import|url\(/);
    expect(html.slice(html.indexOf("<style>"), html.indexOf("</style>"))).not.toContain("/*");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain('name="viewport"');
  });

  it("names every repo and shows no data where a source is absent", () => {
    const html = renderMetricsHtml(report(), "2026-11-20 08:00 UTC");
    expect(html).toContain("example/shop");
    expect(html).toContain("example/blog");
    expect(html).toContain("no data");
    expect(html).toContain("the CLI carries no price table, so cost is not computed");
  });

  it("escapes values that come from records, so a stage name cannot break the page", () => {
    const html = renderMetricsHtml(report(), "2026-11-20 08:00 UTC");
    expect(html).toContain("Time in build &lt;i&gt;, per PR");
    expect(html).not.toContain("<i>");
    expect(escapeHtml(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  });
});
