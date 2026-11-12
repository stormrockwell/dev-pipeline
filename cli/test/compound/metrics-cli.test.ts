import { readFileSync, realpathSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cachePath, writeCache } from "../../src/compound/github.ts";
import { executable, findOnPath, git, makeRepo, pipeline, removeTemps, tempDir, write } from "../helpers/repo.ts";
import { pilotRepos } from "./metrics-fixtures.ts";

afterAll(removeTemps);

const SAVE = "includes/class-save.php";

/**
 * A checkout of the fixture shop, with its origin set the way a clone's is
 */
function shop(): string {
  const repo = realpathSync(makeRepo());
  git(repo, "remote", "add", "origin", "git@github.com:example/shop.git");
  return repo;
}

/**
 * A stub gh that answers each `gh api <path>` from a file named after the path, and with an empty list otherwise
 */
function stubGh(responses: Record<string, unknown>): string {
  const bin = tempDir("pipeline-gh-metrics-");
  for (const [path, body] of Object.entries(responses)) write(bin, `responses/${path.replace(/[^A-Za-z0-9]/g, "_")}`, JSON.stringify(body));
  const script = `#!/bin/sh\nkey=$(printf '%s' "$2" | tr -c 'A-Za-z0-9' '_')\nif [ -f "${bin}/responses/$key" ]; then cat "${bin}/responses/$key"; else echo '[]'; fi\n`;
  executable(join(bin, "gh"), script);
  return [bin, dirname(process.execPath), dirname(findOnPath("git")), "/usr/bin", "/bin"].join(":");
}

describe("pipeline compound metrics", () => {
  it("writes one page from every repo's saved fetch, offline, and keeps it out of git", () => {
    const repo = shop();
    for (const data of pilotRepos()) writeCache(repo, data);
    const names = ["--repo", "example/shop", "--repo", "example/blog"];

    const run = pipeline(repo, ["compound", "metrics", "--offline", ...names, "--since", "2026-11-01", "--out", ".pipeline/compound/metrics.html"]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Wrote the metrics page to");
    const html = readFileSync(join(repo, ".pipeline/compound/metrics.html"), "utf8");
    expect(html).toContain("example/shop");
    expect(html).toContain("example/blog");
    expect(git(repo, "status", "--porcelain", "--untracked-files=all").stdout).toBe("");

    const json = pipeline(repo, ["compound", "metrics", "--offline", ...names, "--since", "2026-11-01", "--json"]);
    expect(json.status).toBe(0);
    const report = JSON.parse(json.stdout);
    expect(report.overall.summary.prs).toBe(6);
    expect(report.repos.map((entry: { repo: string }) => entry.repo)).toEqual(["example/shop", "example/blog"]);
  });

  it("reads each repo through gh, and reads approvals from the reviews", () => {
    const repo = shop();
    const env = {
      PATH: stubGh({
        "repos/example/shop/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1": [
          { number: 1, title: "feat: save", user: { login: "dana", type: "User" }, created_at: "2026-11-02T09:00:00Z", merged_at: "2026-11-02T10:00:00Z", merge_commit_sha: "m1", updated_at: "2026-11-02T10:00:00Z", base: { ref: "main" }, body: "No record here." },
        ],
        "repos/example/shop/pulls/1/files?per_page=100&page=1": [{ filename: SAVE, patch: "@@ -0,0 +1 @@\n+$t = $_POST['t'];" }],
        "repos/example/shop/pulls/1/comments?per_page=100&page=1": [],
        "repos/example/shop/pulls/1/reviews?per_page=100&page=1": [{ user: { login: "riley", type: "User" }, state: "APPROVED", body: "", submitted_at: "2026-11-02T09:30:00Z" }],
        "repos/example/shop/commits?sha=main&since=2026-11-02T10:00:00Z&per_page=100&page=1": [],
      }),
    };

    const run = pipeline(repo, ["compound", "metrics", "--since", "2026-11-01", "--json"], { env });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout);
    expect(report.overall.summary.prs).toBe(1);
    expect(report.overall.summary.attention.approvals).toEqual({ total: 1, of: 1 });
    expect(report.overall.summary.attention.approvalMedianMs).toEqual({ ms: 30 * 60 * 1000, of: 1 });
    expect(report.overall.summary.efficiency.tokens).toBeNull();
    expect(existsSync(cachePath(repo, "example/shop"))).toBe(true);
    expect(readFileSync(join(repo, ".pipeline/compound/metrics.html"), "utf8")).toContain("no data");
    expect(git(repo, "status", "--porcelain", "--untracked-files=all").stdout).toBe("");
  });

  it("refuses bad usage and a repo with no saved fetch to read offline", () => {
    const repo = shop();
    expect(pipeline(repo, ["compound", "metrics", "--window", "0"]).status).toBe(2);
    expect(pipeline(repo, ["compound", "metrics", "--since", "November"]).stderr).toContain("YYYY-MM-DD");
    expect(pipeline(repo, ["compound", "metrics", "--repo", "not a repo"]).stderr).toContain("owner/name");
    expect(pipeline(repo, ["compound", "metrics", "--offline"]).stderr).toContain("no saved fetch of example/shop");
  });

  it("surfaces a gh that cannot read the repo", () => {
    const repo = shop();
    const env = { PATH: denied() };
    const run = pipeline(repo, ["compound", "metrics", "--since", "2026-11-01"], { env });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Bad credentials (HTTP 401)");
  });
});

/**
 * A PATH holding a gh that refuses every call, with the system dirs it needs
 */
function denied(): string {
  const bin = tempDir("pipeline-gh-401-");
  executable(join(bin, "gh"), "#!/bin/sh\necho 'gh: Bad credentials (HTTP 401)' >&2\nexit 1\n");
  return [bin, dirname(process.execPath), dirname(findOnPath("git")), "/usr/bin", "/bin"].join(":");
}
