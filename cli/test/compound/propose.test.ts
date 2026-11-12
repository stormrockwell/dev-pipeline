import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MergedPr, RepoData } from "../../src/compound/github.ts";
import {
  denylist,
  efficiencyFingerprint,
  efficiencyLesson,
  issueBody,
  type IssueApi,
  fileLesson,
  type Lesson,
  PIPELINE_REPO,
  privacyProblem,
  qualityLesson,
  repeatBody,
  rowKey,
  LESSONS,
  FINDINGS,
  targetProblem,
} from "../../src/compound/propose.ts";
import { quality, type QualityReport } from "../../src/compound/quality.ts";
import type { EfficiencyReport } from "../../src/run/efficiency.ts";
import { executable, findOnPath, git, makeRepo, pipeline, removeTemps, root, tempDir, write } from "../helpers/repo.ts";

afterAll(removeTemps);

const CLIENT = "acme-corp/acme-store";
const CHECKOUT = "includes/admin/class-acme-checkout.php";
const QUOTE = "This saves $_POST['acme_total'] without a nonce check, so another site can post the order form.";
const GENERIC = "A path rule that puts form handlers saving request data in the input zone.";

/**
 * A merged PR of the synthetic client whose checkout handler a reviewer caught saving without a nonce
 */
function pr(number: number): MergedPr {
  return {
    number,
    title: `feat(checkout): change ${number}`,
    author: "dana",
    mergedAt: `2026-11-0${number}T10:00:00Z`,
    mergeSha: `m${number}`,
    base: "main",
    files: [{ path: CHECKOUT, zones: ["input"] }],
    comments: [{ author: "riley", kind: "human", body: QUOTE, path: CHECKOUT, zones: ["input"], at: `2026-11-0${number}T09:00:00Z` }],
    record: { version: 2, pipeline: "0.1.0", tiers: ["T2"], zones: [], skipped: [{ gate: "quick security review", reason: "the acme reviewer was away" }], findings: { opened: 0, fixed: 0, accepted: 0 } },
  };
}

/**
 * The quality report of the synthetic client, with three PRs behind the top class
 */
function report(numbers = [1, 2, 3]): QualityReport {
  const data: RepoData = { version: 1, repo: CLIENT, fetchedAt: "2026-11-10T00:00:00Z", since: "2026-11-01T00:00:00Z", prs: numbers.map(pr), commits: [] };
  return quality([data], { windowDays: 14, top: 10 });
}

const top = (data: QualityReport) => data.classes[0]!;

const efficiencyReport: EfficiencyReport = {
  sources: { sessions: 3, streams: 6, calls: 120, from: "2026-11-01T10:00:00Z", to: "2026-11-03T10:00:00Z" },
  stages: [],
  waits: { count: 0, ms: 0, longestMs: 0 },
  slow: [],
  reviews: [],
  sentBack: [],
  retries: [],
  misroutes: [],
  dispatches: [],
  sequences: [{ steps: ["git worktree add", "npm ci", "Read src/acme-pricing.js"], count: 3, streams: 3, sessions: 3, saves: 6 }],
  reads: [{ path: "src/acme-pricing.js", streams: 3, count: 3 }],
};

describe("privacyProblem", () => {
  const deny = denylist(report(), efficiencyReport, ["acme-corp/acme-store"], [PIPELINE_REPO]);

  it("passes one generic sentence, and names of the pipeline's own files and parts", () => {
    expect(privacyProblem(GENERIC, deny)).toBeNull();
    expect(privacyProblem("Add a sensitive.yml path rule and a line in plugin/agents/security-hunter.md for Node.js handlers, e.g. form saves.", deny)).toBeNull();
  });

  it("refuses links, mentions, numbers, slugs, paths, file names, code and long or multi-line text", () => {
    const refused: [string, RegExp][] = [
      ["See https://github.com/acme-corp/acme-store/pull/3 for the case.", /link/],
      ["Ask @riley about the handler.", /mentions/],
      ["Seen on #12 and #14.", /PR or issue number/],
      ["Same as in someone/else today.", /repo or a path/],
      ["The handler in includes/admin/foo.php saves data.", /repo or a path/],
      ["The handler in class-foo.php saves data.", /file outside the pipeline/],
      ["It calls update_option($value) on save.", /code/],
      ["Use `wp_verify_nonce` first.", /code/],
      ["First line.\nSecond line.", /more than one line/],
      ["word ".repeat(80), /longer than/],
      ["", /empty/],
    ];
    for (const [text, reason] of refused) expect(privacyProblem(text, deny), text).toMatch(reason);
  });

  it("refuses the client's name, a path segment, an identifier or a quote from the local reports", () => {
    expect(privacyProblem("A rule for acme-store style checkout handlers.", deny)).toMatch(/repo's name/);
    expect(privacyProblem("A rule for the class-acme-checkout handler.", deny)).toMatch(/path from the local reports/);
    expect(privacyProblem("A rule for the acme-pricing module.", deny)).toMatch(/path from the local reports/);
    expect(privacyProblem("A rule that flags acme_total saves.", deny)).toMatch(/code from a review comment/);
    expect(privacyProblem("A sniff for handlers that save without a nonce check, so another site can post.", deny)).toMatch(/quotes "without a nonce check so"/);
  });

  it("lets plain words through that only a pipeline file or a one-word file stem shares", () => {
    const reads = { ...efficiencyReport, reads: [{ path: ".pipeline/work/*/brief.md", streams: 3, count: 3 }, { path: "src/settings.js", streams: 3, count: 3 }] };
    const plain = denylist(null, reads, [], [PIPELINE_REPO]);
    expect(privacyProblem("Put the task brief and the settings it names into the dispatch prompt.", plain)).toBeNull();
    expect(privacyProblem("Inline settings.js into the prompt.", plain)).toMatch(/file outside the pipeline|path from the local reports/);
  });
});

describe("qualityLesson", () => {
  const data = report();
  const deny = denylist(data, null, [], [PIPELINE_REPO]);

  it("builds the issue from the class's counts and names, and nothing the client wrote", () => {
    const lesson = qualityLesson(data, top(data).fingerprint, "sensitive", GENERIC, deny) as Lesson;
    expect(typeof lesson).toBe("object");
    const text = `${lesson.title}\n${issueBody(lesson, "0.1.0", null)}\n${repeatBody(lesson, 3)}`;
    expect(lesson.title).toBe(`Missed security in zone:input (${top(data).fingerprint})`);
    expect(text).toContain("| Lesson | Missed sensitive code |");
    expect(text).toContain("| Evidence | 3 PRs in 1 repo, 3 human comments |");
    expect(text).toContain("| Hints | planned below T3 on 3 PRs, zone not in the plan on 3 PRs |");
    expect(text).toContain(`<!-- pipeline:lesson ${top(data).fingerprint} -->`);
    expect(text).toContain("Count: 3, so this class is ready for a PR that carries a synthetic eval case");
    for (const secret of ["acme", "riley", "dana", "checkout", "$_POST", "nonce check", "#1", "#2", "/pull/", "includes/"]) expect(text.toLowerCase(), secret).not.toContain(secret.toLowerCase());
    expect(lesson.links).toEqual([1, 2, 3].map((number) => `https://github.com/${CLIENT}/pull/${number}`));
  });

  it("drops a hint that is not one the quality half writes, and refuses an area or class it does not know", () => {
    const tampered = structuredClone(data);
    top(tampered).hints.push("skipped the acme store gate before the fix on 1 PR", "see the checkout file", "skipped quick security review before the fix on 1 PR");
    const lesson = qualityLesson(tampered, top(tampered).fingerprint, "sensitive", GENERIC, deny) as Lesson;
    const hints = lesson.facts.find(([key]) => key === "Hints")![1];
    expect(hints).not.toMatch(/acme|checkout/);
    expect(hints).toContain("skipped quick security review before the fix on 1 PR");
    top(tampered).area = "zone:acme-billing";
    expect(qualityLesson(tampered, top(tampered).fingerprint, "sensitive", GENERIC, deny)).toMatch(/does not name/);
    expect(qualityLesson(data, "q-000000000000", "sensitive", GENERIC, deny)).toMatch(/no class/);
    expect(qualityLesson(data, top(data).fingerprint, "sensitive", "Fix acme-store.", deny)).toMatch(/^--becomes/);
  });

  it("reads a lesson or finding by its key or the start of its table row", () => {
    expect(rowKey(LESSONS, "Missed sensitive code")).toBe("sensitive");
    expect(rowKey(LESSONS, "mechanical")).toBe("mechanical");
    expect(rowKey(FINDINGS, "A tool sequence")).toBe("sequence");
    expect(rowKey(FINDINGS, "A tool sequence that repeats.")).toBe("sequence");
    expect(rowKey(LESSONS, "This is missed sensitive code that was also planned at the wrong tier.")).toBe("sensitive");
    expect(rowKey(FINDINGS, "nothing like it")).toBeNull();
  });
});

describe("efficiencyLesson and targetProblem", () => {
  it("fingerprints a finding by its kind and the pipeline part it changes, the same from any repo", () => {
    const deny = denylist(null, efficiencyReport, [], [PIPELINE_REPO]);
    const lesson = efficiencyLesson(efficiencyReport, "sequence", "dev-pipeline:implementer", "A pipeline command that prepares a worktree in one call.", deny) as Lesson;
    expect(lesson.fingerprint).toBe(efficiencyFingerprint("sequence", "dev-pipeline:implementer"));
    expect(lesson.fingerprint).toMatch(/^e-[0-9a-f]{12}$/);
    expect(lesson.title).toBe(`A tool sequence that repeats in dev-pipeline:implementer (${lesson.fingerprint})`);
    expect(issueBody(lesson, null, 4)).toContain("before and after measurement");
    expect(issueBody(lesson, null, 4)).toContain("An earlier issue for this class, #4, was closed.");
    expect(issueBody(lesson, null, null)).not.toMatch(/acme|pricing/);
  });

  it("takes only parts of the pipeline as a target", () => {
    const parts = { plugin: ["dev-pipeline:implementer"], commands: ["worktree"] };
    expect(targetProblem("dev-pipeline:implementer", parts)).toBeNull();
    expect(targetProblem("pipeline worktree", parts)).toBeNull();
    expect(targetProblem("hooks", parts)).toBeNull();
    expect(targetProblem("dev-pipeline:acme", parts)).toMatch(/no skill or agent/);
    expect(targetProblem("pipeline acme", parts)).toMatch(/no pipeline command/);
    expect(targetProblem("src/acme-pricing.js", parts)).toMatch(/--target takes/);
    expect(targetProblem("dev-pipeline:anything", { plugin: null, commands: [] })).toBeNull();
  });

  it("names the repo the plugin's manifest names", () => {
    const manifest = JSON.parse(readFileSync(join(root, "..", "plugin", ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.repository).toBe(`https://github.com/${PIPELINE_REPO}`);
  });
});

describe("fileLesson", () => {
  const data = report();
  const lesson = qualityLesson(data, top(data).fingerprint, "sensitive", GENERIC, denylist(data, null, [], [PIPELINE_REPO])) as Lesson;
  const mark = `<!-- pipeline:lesson ${lesson.fingerprint} -->`;

  /**
   * An api that answers from a map and records each post
   */
  function api(responses: Record<string, unknown>): IssueApi & { posts: [string, unknown][] } {
    const posts: [string, unknown][] = [];
    return {
      posts,
      get: async (path) => {
        const key = Object.keys(responses).find((prefix) => path.startsWith(prefix));
        return key === undefined ? [] : responses[key];
      },
      post: async (path, body) => {
        posts.push([path, body]);
        return { number: 9, html_url: `https://github.com/${PIPELINE_REPO}/issues/9`, state: "open", body: null };
      },
    };
  }

  it("raises the count on the open issue that carries the mark, past one that only names it", async () => {
    const fake = api({
      "search/issues": { items: [{ number: 5, state: "open", body: "mentions it", html_url: "u5" }, { number: 7, state: "open", body: `${mark}\nbody`, html_url: "u7" }] },
      "repos/stormrockwell/dev-pipeline/issues/7/comments": [{ body: `<!-- pipeline:lesson-seen ${lesson.fingerprint} -->` }, { body: "a person's note" }],
    });
    const filed = await fileLesson(fake, PIPELINE_REPO, lesson, null, null);
    expect(filed).toEqual({ action: "counted", number: 7, url: "u7", count: 3 });
    expect(fake.posts[0]![0]).toBe("repos/stormrockwell/dev-pipeline/issues/7/comments");
    expect((fake.posts[0]![1] as { body: string }).body).toContain("Count: 3, so this class is ready for a PR");
  });

  it("opens a new issue when only a closed one carries the mark, and points at it", async () => {
    const fake = api({ "search/issues": { items: [{ number: 3, state: "closed", body: mark, html_url: "u3" }] } });
    const filed = await fileLesson(fake, PIPELINE_REPO, lesson, "0.1.0", null);
    expect(filed).toMatchObject({ action: "opened", number: 9, count: 1 });
    const sent = fake.posts[0]![1] as { title: string; body: string };
    expect(sent.title).toBe(lesson.title);
    expect(sent.body).toContain("An earlier issue for this class, #3, was closed.");
    expect(sent.body).toContain("| Pipeline | 0.1.0 |");
  });
});

/**
 * A stub gh that logs each call with its stdin and answers from a map of "METHOD path" prefixes
 */
function stubGh(responses: Record<string, unknown>): { path: string; calls: () => { args: string[]; input: string }[] } {
  const bin = tempDir("pipeline-gh-");
  write(bin, "responses.json", JSON.stringify(responses));
  executable(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
const path = args.slice(1).find((arg, index, list) => !arg.startsWith("-") && !["--method", "--input"].includes(list[index - 1]));
const input = method === "GET" ? "" : fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(join(bin, "calls.jsonl"))}, JSON.stringify({ args, input }) + "\\n");
const responses = JSON.parse(fs.readFileSync(${JSON.stringify(join(bin, "responses.json"))}, "utf8"));
const key = Object.keys(responses).find((prefix) => (method + " " + path).startsWith(prefix));
if (key === undefined && path.startsWith("search/")) { process.stdout.write('{"items":[]}'); process.exit(0); }
process.stdout.write(JSON.stringify(key === undefined ? [] : responses[key]));
`,
  );
  const log = join(bin, "calls.jsonl");
  return {
    path: [bin, dirname(process.execPath), dirname(findOnPath("git")), "/usr/bin", "/bin"].join(":"),
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []),
  };
}

describe("pipeline compound file", () => {
  function client(numbers = [1, 2, 3]): string {
    const repo = realpathSync(makeRepo());
    git(repo, "remote", "add", "origin", `git@github.com:${CLIENT}.git`);
    write(repo, ".pipeline/compound/quality.json", JSON.stringify(report(numbers)));
    write(repo, ".pipeline/compound/efficiency.json", JSON.stringify(efficiencyReport));
    git(repo, "add", "-A");
    return repo;
  }
  const fingerprint = top(report()).fingerprint;
  const created = { number: 12, html_url: `https://github.com/${PIPELINE_REPO}/issues/12`, state: "open", body: null };

  it("opens an issue with no client content, keeps the links local, and sends the same evidence once", () => {
    const repo = client();
    const gh = stubGh({ "POST repos/stormrockwell/dev-pipeline/issues": created });
    const run = pipeline(repo, ["compound", "file", "--class", fingerprint, "--lesson", "Missed sensitive code", "--becomes", GENERIC], { env: { PATH: gh.path } });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Opened https://github.com/${PIPELINE_REPO}/issues/12 for ${fingerprint}, seen 1 time.`);
    expect(run.stdout).toContain(`https://github.com/${CLIENT}/pull/1`);

    const calls = gh.calls();
    expect(calls.map((call) => call.args.slice(0, 4).join(" "))).toEqual([expect.stringMatching(/^api search\/issues\?q=/), "api --method POST repos/stormrockwell/dev-pipeline/issues"]);
    expect(decodeURIComponent(calls[0]!.args[1]!)).toContain(`repo:${PIPELINE_REPO} is:issue in:title "${fingerprint}"`);
    const sent = calls[1]!.input;
    for (const secret of ["acme", "riley", "checkout", "nonce check", "/pull/", "includes/"]) expect(sent.toLowerCase(), secret).not.toContain(secret);
    expect(JSON.parse(sent).body).toContain(`<!-- pipeline:lesson ${fingerprint} -->`);

    const filed = JSON.parse(readFileSync(join(repo, ".pipeline/compound/filed.json"), "utf8"));
    expect(filed.lessons[0]).toMatchObject({ fingerprint, repo: PIPELINE_REPO, issue: 12, count: 1, links: [1, 2, 3].map((number) => `https://github.com/${CLIENT}/pull/${number}`) });
    expect(git(repo, "status", "--porcelain").stdout).not.toContain("filed.json");

    const again = pipeline(repo, ["compound", "file", "--class", fingerprint, "--lesson", "sensitive", "--becomes", GENERIC], { env: { PATH: gh.path } });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("Already counted");
    expect(gh.calls()).toHaveLength(2);
  });

  it("counts new evidence on the issue the local record names, and says when the class is ready", () => {
    const repo = client([1, 2]);
    const first = stubGh({ "POST repos/stormrockwell/dev-pipeline/issues": created });
    expect(pipeline(repo, ["compound", "file", "--class", fingerprint, "--lesson", "sensitive", "--becomes", GENERIC], { env: { PATH: first.path } }).status).toBe(0);

    write(repo, ".pipeline/compound/quality.json", JSON.stringify(report([1, 2, 3])));
    const gh = stubGh({
      "GET repos/stormrockwell/dev-pipeline/issues/12/comments": [{ body: `<!-- pipeline:lesson-seen ${fingerprint} -->` }],
      "GET repos/stormrockwell/dev-pipeline/issues/12": { ...created, body: `<!-- pipeline:lesson ${fingerprint} -->` },
      "POST repos/stormrockwell/dev-pipeline/issues/12/comments": { id: 1 },
    });
    const run = pipeline(repo, ["compound", "file", "--class", fingerprint, "--lesson", "sensitive", "--becomes", GENERIC], { env: { PATH: gh.path } });
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("seen 3 times");
    expect(run.stdout).toContain(`ready for a PR on ${PIPELINE_REPO}`);
    const calls = gh.calls().map((call) => call.args.slice(0, 4).join(" "));
    expect(calls).not.toContainEqual(expect.stringMatching(/search/));
    expect(calls.at(-1)).toBe("api --method POST repos/stormrockwell/dev-pipeline/issues/12/comments");
    expect(JSON.parse(gh.calls().at(-1)!.input).body).toContain("Count: 3");
  });

  it("prints what it would send on a dry run and calls no gh", () => {
    const repo = client();
    const gh = stubGh({});
    const run = pipeline(repo, ["compound", "file", "--class", fingerprint, "--lesson", "sensitive", "--becomes", GENERIC, "--dry-run"], { env: { PATH: gh.path } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Dry run, nothing was sent.");
    expect(run.stdout).toContain(`Title: Missed security in zone:input (${fingerprint})`);
    expect(run.stdout).not.toMatch(/acme/i);
    expect(gh.calls()).toEqual([]);
    expect(existsSync(join(repo, ".pipeline/compound/filed.json"))).toBe(false);
  });

  it("files an efficiency finding on a pipeline part, and to the standards repo with --to", () => {
    const repo = client();
    const gh = stubGh({ "POST repos/stormrockwell/coding-standards/issues": { ...created, html_url: "https://github.com/stormrockwell/coding-standards/issues/12" } });
    const run = pipeline(repo, ["compound", "file", "--finding", "sequence", "--target", "dev-pipeline:implementer", "--becomes", "A pipeline command that prepares a worktree in one call.", "--to", "standards"], { env: { PATH: gh.path } });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const sent = JSON.parse(gh.calls().at(-1)!.input);
    expect(sent.title).toBe(`A tool sequence that repeats in dev-pipeline:implementer (${efficiencyFingerprint("sequence", "dev-pipeline:implementer")})`);
    expect(sent.body).toContain("| Evidence | 3 sessions, 6 streams, 120 tool calls |");
    expect(sent.body).not.toMatch(/acme|pricing/);
  });

  it("refuses private text, a target outside the pipeline and bad usage before calling gh", () => {
    const repo = client();
    const gh = stubGh({});
    const env = { env: { PATH: gh.path } };
    const leaky = pipeline(repo, ["compound", "file", "--class", fingerprint, "--lesson", "sensitive", "--becomes", "Guard the acme-pricing module."], env);
    expect(leaky.status).toBe(2);
    expect(leaky.stderr).toContain("path from the local reports");
    expect(pipeline(repo, ["compound", "file", "--finding", "sequence", "--target", "src/acme-pricing.js", "--becomes", GENERIC], env).stderr).toContain("--target takes");
    expect(pipeline(repo, ["compound", "file", "--class", fingerprint, "--lesson", "vibes", "--becomes", GENERIC], env).stderr).toContain("--lesson takes");
    expect(pipeline(repo, ["compound", "file", "--class", fingerprint, "--finding", "sequence", "--becomes", GENERIC], env).stderr).toContain("name one lesson");
    expect(pipeline(repo, ["compound", "file", "--class", fingerprint, "--lesson", "sensitive"], env).stderr).toContain("--becomes is required");
    expect(pipeline(repo, ["compound", "file", "--class", fingerprint, "--lesson", "sensitive", "--becomes", GENERIC, "--to", "elsewhere"], env).status).toBe(2);
    expect(gh.calls()).toEqual([]);
  });

  it("reports gh's error when it cannot write the issue", () => {
    const repo = client();
    const bin = tempDir("pipeline-gh-");
    executable(join(bin, "gh"), "#!/bin/sh\necho 'gh: Resource not accessible (HTTP 403)' >&2\nexit 1\n");
    const run = pipeline(repo, ["compound", "file", "--class", fingerprint, "--lesson", "sensitive", "--becomes", GENERIC], { env: { PATH: [bin, dirname(process.execPath), dirname(findOnPath("git")), "/usr/bin", "/bin"].join(":") } });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("HTTP 403");
    expect(existsSync(join(repo, ".pipeline/compound/filed.json"))).toBe(false);
  });
});
