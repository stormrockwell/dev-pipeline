import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { commentKind, fetchRepo, type Gh, GhError, type MergedPr, type RepoData, repoOfRemote, zonesOf } from "../../src/compound/github.ts";
import { axisOf, fingerprint, ownerOf, quality, renderQuality } from "../../src/compound/quality.ts";
import { builtinConfig } from "../../src/commands/scan-zones/config.ts";
import { executable, findOnPath, git, makeRepo, pipeline, removeTemps, tempDir, write } from "../helpers/repo.ts";

afterAll(removeTemps);

const config = builtinConfig();
const SAVE = "includes/class-save.php";
const PRICES = "src/prices.js";

/**
 * A merged PR of the synthetic shop, merged on a day of November 2026
 */
function pr(number: number, day: number, files: string[], extra: Partial<MergedPr> = {}): MergedPr {
  return {
    number,
    title: `feat: change ${number}`,
    author: "dana",
    mergedAt: `2026-11-${String(day).padStart(2, "0")}T10:00:00Z`,
    mergeSha: `m${number}`,
    base: "main",
    files: files.map((path) => ({ path, zones: path === SAVE ? ["input"] : [] })),
    comments: [],
    record: null,
    ...extra,
  };
}

function commit(sha: string, day: number, subject: string, files: string[], message = subject): RepoData["commits"][number] {
  return { sha, subject, message, at: `2026-11-${String(day).padStart(2, "0")}T12:00:00Z`, files: files.map((path) => ({ path, zones: path === SAVE ? ["input"] : [] })) };
}

function repo(prs: MergedPr[], commits: RepoData["commits"], name = "example/shop"): RepoData {
  return { version: 1, repo: name, fetchedAt: "2026-11-30T00:00:00Z", since: "2026-11-01T00:00:00Z", prs, commits };
}

const record = (skipped: { gate: string; reason: string }[], zones: string[] = [], tiers = ["T2"]) => ({ version: 2, pipeline: "0.1.0", tiers, zones, skipped, findings: { opened: 0, fixed: 0, accepted: 0 } });

describe("axisOf and ownerOf", () => {
  it("reads the highest axis a comment names, and correctness when it names none", () => {
    expect(axisOf("Missing nonce check, and a typo")).toBe("security");
    expect(axisOf("This runs a query per row")).toBe("performance");
    expect(axisOf("Rename this to something clearer")).toBe("style");
    expect(axisOf("Duplicates the helper above")).toBe("readability");
    expect(axisOf("fix(cart): total is off by one")).toBe("correctness");
    expect([ownerOf("security"), ownerOf("correctness"), ownerOf("readability"), ownerOf("style"), ownerOf("performance")]).toEqual(["security", "spec", "simplifier", "standards", "performance"]);
  });
});

describe("quality", () => {
  it("counts a person's review comment, and leaves agents and the author's replies out of the classes", () => {
    const comments: MergedPr["comments"] = [
      { author: "riley", kind: "human", body: "This saves $_POST without a nonce check.", path: SAVE, zones: ["input", "csrf"], at: "2026-11-02T09:00:00Z" },
      { author: "claude[bot]", kind: "agent", body: null, path: null, zones: [], at: "2026-11-02T09:00:00Z" },
      { author: "dana", kind: "author", body: null, path: null, zones: [], at: "2026-11-02T09:30:00Z" },
    ];
    const report = quality([repo([pr(1, 2, [SAVE], { comments })], [])], { windowDays: 14, top: 10 });
    expect(report.comments).toEqual({ human: 1, agent: 1, author: 1, reviewers: 1, prs: 1 });
    expect(report.classes.map((entry) => [entry.axis, entry.area, entry.signals.human, entry.score])).toEqual([
      ["security", "zone:csrf", 1, 3],
      ["security", "zone:input", 1, 3],
    ]);
    expect(report.classes[0]!.examples[0]).toEqual({ repo: "example/shop", pr: 1, kind: "human", text: "This saves $_POST without a nonce check.", path: SAVE });
  });

  it("pins a fix on the last PR that touched its files within the window, past bookkeeping files", () => {
    const prs = [pr(1, 1, [PRICES, "package-lock.json"]), pr(2, 3, ["README.md", "package-lock.json"]), pr(3, 5, [PRICES])];
    const commits = [
      commit("f1", 6, "fix(prices): round the discount", [PRICES, "package-lock.json"]),
      commit("f2", 6, "fix: bump the lock", ["package-lock.json"]),
      commit("f3", 30, "fix(prices): late fix", [PRICES]),
    ];
    const report = quality([repo(prs, commits)], { windowDays: 14, top: 10 });
    expect(report.fixes).toEqual({ commits: 1, prs: 1 });
    expect(report.classes).toHaveLength(1);
    expect(report.classes[0]).toMatchObject({ axis: "correctness", area: "rules:ts_js_tsx_jsx", owner: "spec", prs: 1, examples: [{ pr: 3, kind: "fix", text: "fix(prices): round the discount" }] });
  });

  it("counts a revert against the PR its message names", () => {
    const prs = [pr(1, 1, [SAVE])];
    const commits = [commit("r1", 2, 'Revert "feat: change 1"', [SAVE], 'Revert "feat: change 1"\n\nThis reverts commit m1.')];
    const report = quality([repo(prs, commits)], { windowDays: 14, top: 10 });
    expect(report.reverts).toEqual({ commits: 1, prs: 1 });
    expect(report.classes[0]).toMatchObject({ axis: "correctness", area: "zone:input", signals: { revert: 1 }, score: 3 });
  });

  it("tells skipped gates that later needed a fix from clean PRs, and hints at a zone the plan missed", () => {
    const prs = [
      pr(1, 1, [SAVE], { record: record([{ gate: "quick security review", reason: "reviewer not built" }]) }),
      pr(2, 1, [PRICES], { record: record([]) }),
      pr(3, 1, ["src/cart.js"], { record: record([{ gate: "performance", reason: "no queries" }]) }),
      pr(4, 1, ["src/other.js"]),
    ];
    const commits = [commit("f1", 3, "fix: escape the saved title", [SAVE]), commit("f2", 3, "fix(prices): rounding", [PRICES])];
    const report = quality([repo(prs, commits)], { windowDays: 14, top: 10 });
    expect(report.sources).toMatchObject({ prs: 4, records: 3 });
    expect(report.skips).toEqual({
      recorded: 3,
      skipped: 2,
      skippedThenFixed: 1,
      cleanThenFixed: 1,
      gates: [
        { gate: "performance", skipped: 1, laterFixed: 0 },
        { gate: "quick security review", skipped: 1, laterFixed: 1 },
      ],
    });
    const security = report.classes.find((entry) => entry.area === "zone:input" && entry.axis === "security")!;
    expect(security.signals).toEqual({ human: 0, fix: 1, revert: 0, skip: 1 });
    expect(security.hints).toEqual(["planned below T3 on 1 PR", "skipped quick security review before the fix on 1 PR", "zone not in the plan on 1 PR"]);
  });

  it("gives a class the same fingerprint from any repo and ranks by weight", () => {
    const comment = { author: "riley", kind: "human" as const, body: "Missing capability check", path: SAVE, zones: ["input"], at: "2026-11-02T09:00:00Z" };
    const a = repo([pr(1, 1, [SAVE], { comments: [comment] })], [], "example/shop");
    const b = repo([pr(7, 1, [SAVE], { comments: [comment] }), pr(8, 1, [PRICES])], [commit("f1", 2, "fix: rounding", [PRICES])], "example/blog");
    const report = quality([a, b], { windowDays: 14, top: 1 });
    expect(report.classes).toHaveLength(1);
    expect(report.classes[0]).toMatchObject({ fingerprint: fingerprint("security", "zone:input"), prs: 2, repos: 2, score: 6 });
    expect(fingerprint("security", "zone:input")).toMatch(/^q-[0-9a-f]{12}$/);
    expect(renderQuality(report)).toContain("1. security in zone:input, owner security, score 6: 2 human on 2 PRs");
  });

  it("degrades to counts when no PR carries a record or a signal", () => {
    const report = quality([repo([pr(1, 1, [PRICES])], [])], { windowDays: 14, top: 10 });
    expect(report.classes).toEqual([]);
    expect(report.skips.recorded).toBe(0);
    expect(renderQuality(report)).toContain("Classes  none");
  });
});

describe("fetching from GitHub", () => {
  it("tells a person's comment from an agent's and the author's", () => {
    expect(commentKind({ login: "riley", type: "User" }, "Needs a nonce.", "dana")).toBe("human");
    expect(commentKind({ login: "dana", type: "User" }, "Fixed.", "dana")).toBe("author");
    expect(commentKind({ login: "copilot[bot]", type: "Bot" }, "Consider this.", "dana")).toBe("agent");
    expect(commentKind({ login: "dana", type: "User" }, "Route: review\n\nFound 2 issues.", "riley")).toBe("agent");
    expect(commentKind({ login: "riley", type: "User" }, "Summary.\n\nCo-Authored using AI", "dana")).toBe("agent");
  });

  it("finds zones from a patch's added lines and context", () => {
    expect(zonesOf(config, SAVE, "@@ -1,2 +1,3 @@\n <?php\n+$title = $_POST['title'];\n update_option('t', $title);")).toContain("input");
    expect(zonesOf(config, PRICES, "@@ -1 +1 @@\n-a\n+b")).toEqual([]);
    expect(zonesOf(config, ".github/workflows/ci.yml", null)).toContain("guardrails");
  });

  it("reads merged PRs, their comments and record, and the fix commits after them", async () => {
    const recordBody = `What changed.\r\n\r\n<!-- pipeline:gate-record\r\n${JSON.stringify({ version: 1, work: "w", tasks: [{ id: "1", tier: "T2", zones: [] }], gates: [{ task: "1", gate: "spec", result: "skip", note: "docs only" }, { task: "1", gate: "TDD", result: "pending", note: null }], findings: { opened: 2, fixed: 2, accepted: 0 } })}\r\n-->`;
    const responses: Record<string, unknown> = {
      "repos/example/shop/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1": [
        { number: 5, title: "feat: save", user: { login: "dana", type: "User" }, merged_at: "2026-11-02T10:00:00Z", merge_commit_sha: "m5", updated_at: "2026-11-02T10:00:00Z", base: { ref: "main" }, body: recordBody },
        { number: 4, title: "feat: closed", user: { login: "dana" }, merged_at: null, merge_commit_sha: null, updated_at: "2026-11-02T09:00:00Z", base: { ref: "main" }, body: null },
      ],
      "repos/example/shop/pulls/5/files?per_page=100&page=1": [{ filename: SAVE, patch: "@@ -0,0 +1 @@\n+$t = $_POST['t'];" }],
      "repos/example/shop/pulls/5/comments?per_page=100&page=1": [{ user: { login: "riley", type: "User" }, body: "Where is the nonce?", path: SAVE, diff_hunk: "@@ -0,0 +1 @@\n+$t = $_POST['t'];", created_at: "2026-11-02T09:00:00Z" }],
      "repos/example/shop/pulls/5/reviews?per_page=100&page=1": [{ user: { login: "riley", type: "User" }, body: "LGTM", submitted_at: "2026-11-02T09:30:00Z" }],
      "repos/example/shop/issues/5/comments?per_page=100&page=1": [{ user: { login: "github-actions[bot]", type: "Bot" }, body: "Checks passed", created_at: "2026-11-02T09:10:00Z" }],
      "repos/example/shop/commits?sha=main&since=2026-11-02T10:00:00Z&per_page=100&page=1": [
        { sha: "f1", commit: { message: "fix(save): check the nonce", committer: { date: "2026-11-03T10:00:00Z" }, author: null } },
        { sha: "c1", commit: { message: "feat: unrelated", committer: { date: "2026-11-03T11:00:00Z" }, author: null } },
      ],
      "repos/example/shop/commits/f1": { files: [{ filename: SAVE, patch: "@@ -1 +1,2 @@\n+check_admin_referer('save');\n $t = $_POST['t'];" }] },
    };
    const asked: string[] = [];
    const call: Gh = async (path) => {
      asked.push(path);
      if (!(path in responses)) throw new GhError(`gh api ${path} failed: unexpected`);
      return responses[path];
    };

    const data = await fetchRepo(call, "example/shop", new Date("2026-11-01T00:00:00Z"), config);

    expect(data.prs).toHaveLength(1);
    const [merged] = data.prs;
    expect(merged!.files).toEqual([{ path: SAVE, zones: ["input"] }]);
    expect(merged!.comments).toEqual([
      { author: "riley", kind: "human", body: "Where is the nonce?", path: SAVE, zones: ["input"], at: "2026-11-02T09:00:00Z" },
      { author: "github-actions[bot]", kind: "agent", body: null, path: null, zones: [], at: "2026-11-02T09:10:00Z" },
    ]);
    expect(merged!.record).toEqual({ version: 1, pipeline: null, tiers: ["T2"], zones: [], skipped: [{ gate: "spec", reason: "docs only" }, { gate: "TDD", reason: "not run" }], findings: { opened: 2, fixed: 2, accepted: 0 } });
    expect(data.commits.map((entry) => [entry.sha, entry.subject, entry.files[0]!.zones])).toEqual([["f1", "fix(save): check the nonce", ["csrf"]]]);
    expect(asked).not.toContain("repos/example/shop/commits/c1");
  });

  it("parses the repo of a GitHub remote", () => {
    expect(repoOfRemote("git@github.com:example/shop.git\n")).toBe("example/shop");
    expect(repoOfRemote("https://github.com/example/shop")).toBe("example/shop");
    expect(repoOfRemote("ssh://git@github.com/example/shop.git")).toBe("example/shop");
    expect(repoOfRemote("git@gitlab.com:example/shop.git")).toBeNull();
  });
});

/**
 * A stub gh that answers each `gh api <path>` from a file named after the path, and with an empty list otherwise
 */
function stubGh(responses: Record<string, unknown>, failWith: string | null = null): string {
  const bin = tempDir("pipeline-gh-");
  for (const [path, body] of Object.entries(responses)) write(bin, `responses/${path.replace(/[^A-Za-z0-9]/g, "_")}`, JSON.stringify(body));
  const script = failWith
    ? `#!/bin/sh\necho '${failWith}' >&2\nexit 1\n`
    : `#!/bin/sh\nkey=$(printf '%s' "$2" | tr -c 'A-Za-z0-9' '_')\nif [ -f "${bin}/responses/$key" ]; then cat "${bin}/responses/$key"; else echo '[]'; fi\n`;
  executable(join(bin, "gh"), script);
  return [bin, dirname(process.execPath), dirname(findOnPath("git")), "/usr/bin", "/bin"].join(":");
}

describe("pipeline compound quality", () => {
  const since = "2026-11-01";
  const responses = {
    "repos/example/shop/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1": [
      { number: 1, title: "feat: save", user: { login: "dana", type: "User" }, merged_at: "2026-11-02T10:00:00Z", merge_commit_sha: "m1", updated_at: "2026-11-02T10:00:00Z", base: { ref: "main" }, body: "No record here." },
    ],
    "repos/example/shop/pulls/1/files?per_page=100&page=1": [{ filename: SAVE, patch: "@@ -0,0 +1 @@\n+$t = $_POST['t'];" }],
    "repos/example/shop/pulls/1/comments?per_page=100&page=1": [{ user: { login: "riley", type: "User" }, body: "Escape this before saving.", path: SAVE, diff_hunk: "@@ -0,0 +1 @@\n+$t = $_POST['t'];", created_at: "2026-11-02T09:00:00Z" }],
    "repos/example/shop/commits?sha=main&since=2026-11-02T10:00:00Z&per_page=100&page=1": [{ sha: "f1", commit: { message: "fix: sanitize the title", committer: { date: "2026-11-04T10:00:00Z" }, author: null } }],
    "repos/example/shop/commits/f1": { files: [{ filename: SAVE, patch: "@@ -1 +1 @@\n-$t = $_POST['t'];\n+$t = sanitize_text_field( $_POST['t'] );" }] },
  };

  function shop(): string {
    const repo = realpathSync(makeRepo());
    git(repo, "remote", "add", "origin", "git@github.com:example/shop.git");
    return repo;
  }

  it("reads this checkout's repo through gh, keeps the fetch out of git, and reads it again offline", () => {
    const repo = shop();
    const env = { PATH: stubGh(responses) };
    const run = pipeline(repo, ["compound", "quality", "--since", since, "--out", ".pipeline/compound/quality.json"], { env });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("1 merged PR in 1 repo, 0 with a gate record");
    expect(run.stdout).toContain("1 human from 1 reviewer on 1 PR");
    expect(run.stdout).toContain("1. security in zone:input, owner security, score 5: 1 human, 1 fix on 1 PR");
    const saved = JSON.parse(readFileSync(join(repo, ".pipeline/compound/quality.json"), "utf8"));
    expect(saved.classes[0]).toMatchObject({ axis: "security", area: "zone:input", signals: { human: 1, fix: 1 } });
    expect(git(repo, "status", "--porcelain", "--untracked-files=all").stdout).toBe("");

    const offline = pipeline(repo, ["compound", "quality", "--since", since, "--offline", "--json"], { env: { PATH: stubGh({}, "gh: should not be called") } });
    expect(offline.status).toBe(0);
    expect(JSON.parse(offline.stdout).classes).toEqual(saved.classes);
  });

  it("refuses bad usage, a checkout with no GitHub origin, and a gh that cannot read the repo", () => {
    const repo = shop();
    expect(pipeline(repo, ["compound", "quality", "--window", "0"]).status).toBe(2);
    expect(pipeline(repo, ["compound", "quality", "--repo", "not a repo"]).stderr).toContain("owner/name");
    expect(pipeline(repo, ["compound", "quality", "--offline"]).stderr).toContain("no saved fetch of example/shop");
    expect(pipeline(realpathSync(makeRepo()), ["compound", "quality"]).stderr).toContain("no GitHub origin");
    const denied = pipeline(repo, ["compound", "quality", "--since", since], { env: { PATH: stubGh({}, "gh: Bad credentials (HTTP 401)") } });
    expect(denied.status).toBe(2);
    expect(denied.stderr).toContain("Bad credentials (HTTP 401)");
  });
});
