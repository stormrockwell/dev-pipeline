import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { diffBaseline, readBaseline, violationKey, writeBaseline } from "../src/commands/a11y/baseline.ts";
import { runA11y } from "../src/commands/a11y/index.ts";
import { readA11yProfile, resolveUrls, TARGET_TAGS } from "../src/commands/a11y/profile.ts";
import { type AxeRunner, openPlaywrightRunner, type PageResult, pathOf, RunnerError, violationsOf } from "../src/commands/a11y/runner.ts";
import { pipeline, removeTemps, tempDir, write } from "./helpers/repo.ts";

afterAll(removeTemps);

const violation = (id: string, targets: string[], impact = "serious") => ({ id, impact, help: `${id} help`, nodes: targets.map((target) => ({ target: [target] })) });

/**
 * A runner that replays recorded axe results by page path
 */
function recorded(pages: Record<string, PageResult["violations"]>): AxeRunner {
  return {
    async scan(url) {
      const found = pages[pathOf(url)];
      if (!found) throw new RunnerError(`could not reach ${url}`);
      return { url, violations: found };
    },
    async close() {},
  };
}

/**
 * Runs the command in process and returns its exit code with what it printed
 */
async function run(args: string[], runner?: AxeRunner): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void out.push(String(line)));
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void err.push(String(line)));
  const code = await runA11y(args, runner);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

afterEach(() => vi.restoreAllMocks());

describe("violations and keys", () => {
  it("makes one violation per failing node, keyed by rule, page path and selector", () => {
    const found = violationsOf({ url: "http://127.0.0.1:9/shop/?q=1#top", violations: [violation("image-alt", ["img.hero", "img.logo"])] });
    expect(found.map(violationKey)).toEqual(["image-alt\u0000/shop/\u0000img.hero", "image-alt\u0000/shop/\u0000img.logo"]);
  });

  it("joins an iframe or shadow root target into one selector", () => {
    const [found] = violationsOf({ url: "http://x/", violations: [{ id: "label", help: "h", nodes: [{ target: ["iframe", ["#host", "input"]] }] }] });
    expect(found?.selector).toBe("iframe >> #host input");
    expect(found?.impact).toBe("unknown");
  });

  it("keeps a violation's identity when the host and port change", () => {
    const a = violationsOf({ url: "http://127.0.0.1:3000/a", violations: [violation("label", ["#q"])] });
    const b = violationsOf({ url: "http://localhost:9999/a", violations: [violation("label", ["#q"])] });
    expect(a.map(violationKey)).toEqual(b.map(violationKey));
  });
});

describe("the baseline ratchet", () => {
  const dir = () => join(tempDir(), ".pipeline/a11y-baseline.json");
  const entry = (rule: string, url: string, selector: string) => ({ rule, url, selector });

  it("treats a missing baseline as empty, so every violation is new", () => {
    expect(readBaseline(dir())).toBeNull();
    expect(diffBaseline([entry("label", "/", "#q")], null, ["/"]).added).toHaveLength(1);
  });

  it("splits a scan into new, kept and fixed, and ignores entries of pages the scan skipped", () => {
    const path = dir();
    const baseline = writeBaseline(path, "wcag22aa", [entry("label", "/", "#q"), entry("image-alt", "/", "img"), entry("color-contrast", "/about", "p")], ["/", "/about"], null);
    const diff = diffBaseline([entry("label", "/", "#q"), entry("button-name", "/", "button")], baseline, ["/"]);
    expect(diff.added.map((found) => found.rule)).toEqual(["button-name"]);
    expect(diff.kept.map((found) => found.rule)).toEqual(["label"]);
    expect(diff.fixed.map((found) => found.rule)).toEqual(["image-alt"]);
  });

  it("replaces the scanned pages on record and keeps the others", () => {
    const path = dir();
    const first = writeBaseline(path, "wcag22aa", [entry("label", "/", "#q"), entry("color-contrast", "/about", "p")], ["/", "/about"], null);
    writeBaseline(path, "wcag22aa", [], ["/"], first);
    expect(readBaseline(path)?.violations).toEqual([entry("color-contrast", "/about", "p")]);
  });

  it("rejects a file that is not a baseline", () => {
    const path = join(tempDir(), "b.json");
    writeFileSync(path, '{"violations": [{"rule": 1}]}');
    expect(() => readBaseline(path)).toThrow("not an a11y baseline");
    writeFileSync(path, "{nope");
    expect(() => readBaseline(path)).toThrow("not valid JSON");
  });
});

describe("pipeline a11y with recorded axe results", () => {
  const site = "http://127.0.0.1:4000";

  it("records a baseline, passes against it, and fails naming only the new violation", async () => {
    const repo = tempDir();
    const before = { "/": [violation("color-contrast", ["p.muted"])] };
    expect((await run(["--base-url", site, "--path", repo, "--update-baseline"], recorded(before))).code).toBe(0);
    expect((await run(["--base-url", site, "--path", repo], recorded(before))).code).toBe(0);

    const after = { "/": [violation("color-contrast", ["p.muted"]), violation("image-alt", ["img.hero"], "critical")] };
    const result = await run(["--base-url", site, "--path", repo], recorded(after));
    expect(result.code).toBe(1);
    expect(result.out).toContain("image-alt");
    expect(result.out).toContain("img.hero");
    expect(result.out).not.toContain("color-contrast");
    expect(result.out).toContain("1 new, 1 in the baseline");
  });

  it("fails when there is no baseline and says how to record one", async () => {
    const result = await run(["--base-url", site, "--path", tempDir()], recorded({ "/": [violation("label", ["#q"])] }));
    expect(result.code).toBe(1);
    expect(result.out).toContain("--update-baseline");
  });

  it("scans the pages asked for and the profile's pages", async () => {
    const repo = tempDir();
    write(repo, ".pipeline/profile.yml", "accessibility:\n  target: wcag21aa\n  urls: [/, /contact/]\n");
    const seen: string[] = [];
    const runner: AxeRunner = { async scan(url) { seen.push(url); return { url, violations: [] }; }, async close() {} };
    expect((await run(["--base-url", site, "--path", repo, "--url", "/orders/", "--json"], runner)).code).toBe(0);
    expect(seen).toEqual([`${site}/orders/`, `${site}/`, `${site}/contact/`]);
  });

  it("fails closed when a page cannot be scanned, and never records a partial baseline", async () => {
    const repo = tempDir();
    const result = await run(["--base-url", site, "--path", repo, "--url", "/missing/", "--update-baseline"], recorded({ "/": [] }));
    expect(result.code).toBe(1);
    expect(result.err).toContain("could not reach");
    expect(readBaseline(join(repo, ".pipeline/a11y-baseline.json"))).toBeNull();
  });

  it("records the axe gate in the ledger when given a work order and task", async () => {
    const repo = tempDir();
    const order = join(repo, "work-order.md");
    write(repo, "work-order.md", "# Work\n");
    await run(["--base-url", site, "--path", repo, "--work-order", order, "--task", "1"], recorded({ "/": [violation("label", ["#q"])] }));
    const ledger = readFileSync(join(repo, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { gate: string; result: string });
    expect(ledger.at(-1)).toMatchObject({ gate: "axe", result: "fail" });
  });

  it("rejects bad usage with exit 2", async () => {
    expect((await run(["--path", tempDir()])).code).toBe(2);
    expect((await run(["--base-url", site, "--target", "wcag9"])).code).toBe(2);
    expect((await run(["--base-url", site, "--task", "1"])).code).toBe(2);
    expect((await run(["--base-url", site, "--timeout", "0"])).code).toBe(2);
  });

  it("is listed by the CLI with its usage", () => {
    expect(pipeline(tempDir(), ["a11y", "--help"]).stdout).toContain("--update-baseline");
  });
});

describe("profile", () => {
  it("defaults to WCAG 2.2 AA with no profile, and maps each target to cumulative axe tags", () => {
    expect(readA11yProfile(tempDir())).toEqual({ target: "wcag22aa", urls: [], baseUrl: null });
    expect(TARGET_TAGS.wcag22aa).toEqual(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
  });

  it("reads target, urls and base_url, and resolves pages against the site without repeats", () => {
    const repo = tempDir();
    write(repo, ".pipeline/profile.yml", "accessibility:\n  target: wcag2aa\n  base_url: http://localhost:8080\n  urls: [/, /a/]\n");
    expect(readA11yProfile(repo)).toEqual({ target: "wcag2aa", urls: ["/", "/a/"], baseUrl: "http://localhost:8080" });
    expect(resolveUrls("http://h:1", ["/a/"], ["/", "/a/"])).toEqual(["http://h:1/a/", "http://h:1/"]);
    expect(resolveUrls("http://h:1", [], [])).toEqual(["http://h:1/"]);
  });
});

const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head><body><main><h1>Shop</h1>${body}</main></body></html>`;

describe("pipeline a11y in a real browser", () => {
  let server: Server;
  let base = "";
  let browser = "";
  let body = "";

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      if (request.url === "/gone") {
        response.statusCode = 404;
        response.end("nope");
        return;
      }
      response.end(page(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await (await openPlaywrightRunner(30)).close();
    } catch (error) {
      browser = error instanceof Error ? error.message : String(error);
      console.warn(`a11y browser tests skipped: ${browser}`);
    }
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const real = (name: string, test: (repo: string) => Promise<void>) => it(name, async (context) => (browser ? context.skip() : test(tempDir())), 90_000);

  real("blocks an img without alt and an unlabeled input added after the baseline, naming only those", async (repo) => {
    body = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Logo"><label for="q">Search</label><input id="q" type="text">';
    expect((await run(["--base-url", base, "--path", repo, "--update-baseline"])).code).toBe(0);
    expect((await run(["--base-url", base, "--path", repo])).code).toBe(0);

    body += '<img id="hero" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><input id="email" type="text">';
    const result = await run(["--base-url", base, "--path", repo]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("image-alt");
    expect(result.out).toContain("#hero");
    expect(result.out).toContain("label");
    expect(result.out).toContain("#email");
    expect(result.out).not.toContain("#q");
    expect(result.out).toContain("2 new");
  });

  real("keeps an old violation off the list when the page's text changes around it", async (repo) => {
    body = '<img id="hero" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
    await run(["--base-url", base, "--path", repo, "--update-baseline"]);
    body = `<p>New copy</p>${body}`;
    expect((await run(["--base-url", base, "--path", repo])).code).toBe(0);
  });

  real("fails closed on an unreachable site and on a page that answers 404", async (repo) => {
    const down = createServer();
    await new Promise<void>((resolve) => down.listen(0, "127.0.0.1", resolve));
    const port = (down.address() as AddressInfo).port;
    await new Promise<void>((resolve) => down.close(() => resolve()));
    const refused = await run(["--base-url", `http://127.0.0.1:${port}`, "--path", repo, "--timeout", "10"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("could not reach");
    const missing = await run(["--base-url", base, "--path", repo, "--url", "/gone"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("answered 404");
  });
});
