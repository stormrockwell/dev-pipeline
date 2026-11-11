import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { auditors, securityCallouts, type RecordJson } from "../../src/commands/pr-body/auditors.ts";
import { assembleBody, humanReviewLine, parseDraft } from "../../src/commands/pr-body/body.ts";
import { git, pipeline, removeTemps, write } from "../helpers/repo.ts";
import { brief, commitAll, fixShipping, taskRepo, writeTest } from "./fixture.ts";

afterAll(removeTemps);

const order = ".pipeline/work/ship/work-order.md";

const draft = [
  "Title: fix(shipping): ship free at exactly the threshold",
  "",
  "## What changed",
  "",
  "- An order of exactly 75 now ships free.",
  "",
  "## Why this approach",
  "",
  "The comparison was off by one, so it now includes the threshold.",
  "",
  "## How to verify",
  "",
  "```",
  "node --test",
  "```",
  "",
  "## Risk",
  "",
  "Door: two-way.",
  "Blast radius: the free shipping check.",
  "Human review: none.",
  "",
  "## Auditors",
  "",
  "- Ran: everything",
  "",
  "Co-Authored using AI",
  "",
].join("\n");

describe("auditors", () => {
  const record = (gates: RecordJson["gates"], extra: Partial<RecordJson> = {}): RecordJson => ({
    work: "ship",
    pr: null,
    tasks: [{ id: "1", tier: "T2", zones: [], status: "DONE" }],
    gates,
    ...extra,
  });

  it("lists passed gates as Ran and the rest as Skipped with their reasons", () => {
    expect(
      auditors(
        record([
          { task: "1", gate: "TDD", result: "pass", note: "red then green" },
          { task: "1", gate: "spec", result: "pass", note: null },
          { task: "1", gate: "performance", result: "skip", note: "no queries, no loops" },
          { task: "1", gate: "quick security review", result: "pending", note: null },
        ]),
      ),
    ).toEqual(["- Ran: TDD, spec", "- Skipped: performance (no queries; no loops), quick security review (not run)"]);
  });

  it("names the task when a gate passed for one task and not another", () => {
    const lines = auditors(
      record(
        [
          { task: "1", gate: "spec", result: "pass", note: null },
          { task: "2", gate: "spec", result: "pending", note: null },
        ],
        { tasks: [{ id: "1", tier: "T2", zones: [], status: "DONE" }, { id: "2", tier: "T2", zones: [], status: "DONE" }] },
      ),
    );
    expect(lines).toEqual(["- Skipped: spec (task 2: not run)"]);
  });

  it("adds Accepted only for a dismissed finding", () => {
    const pass = [{ task: "1", gate: "spec", result: "pass" as const, note: null }];
    expect(auditors(record(pass)).some((line) => line.startsWith("- Accepted"))).toBe(false);
    expect(auditors(record(pass, { accepted: [{ task: "1", gate: "standards", finding: "long function, 60 lines", reason: "mirrors core" }] }))).toContain(
      "- Accepted: standards on task 1: long function; 60 lines (mirrors core)",
    );
  });
});

describe("securityCallouts", () => {
  const task = (id: string, tier: string) => ({ id, tier, zones: [], status: "DONE" });
  const record = (tier: string, gate: RecordJson["gates"][number]["result"], note: string | null = null): RecordJson => ({
    work: "ship",
    pr: null,
    tasks: [task("1", tier)],
    gates: [{ task: "1", gate: tier === "T0" ? "light security pass" : tier === "T2" ? "quick security review" : "full security review with verifier vote", result: gate, note }],
  });

  it.each(["T0", "T1", "T2"])("says a %s task's unrecorded security gate was not recorded", (tier) => {
    expect(securityCallouts(record(tier, "pending"))).toEqual(["Security review: not run for task 1 (not recorded)."]);
  });

  it("gives the skip note as the reason, one line per task", () => {
    const skipped = record("T2", "skip", "security reviewer not built yet");
    skipped.tasks.push(task("2", "T0"));
    skipped.gates.push({ task: "2", gate: "light security pass", result: "pending", note: null });
    expect(securityCallouts(skipped)).toEqual(["Security review: not run for task 1 (security reviewer not built yet).", "Security review: not run for task 2 (not recorded)."]);
  });

  it("says nothing when the security gate passed or the plan has none", () => {
    expect(securityCallouts(record("T2", "pass"))).toEqual([]);
    expect(securityCallouts({ ...record("T2", "pass"), gates: [] })).toEqual([]);
  });
});

describe("parseDraft and assembleBody", () => {
  it("keeps the agent's sections and replaces the parts a script owns", () => {
    const parsed = parseDraft(draft);
    expect(parsed.title).toBe("fix(shipping): ship free at exactly the threshold");
    expect(parsed.sections.map((section) => section.heading)).toEqual(["What changed", "Why this approach", "How to verify", "Risk"]);
    const zones = new Map([["input", new Map([["src/api.js", [12, 4, 12]]])]]);
    const body = assembleBody(parsed, zones, ["- Ran: TDD"], "<!-- pipeline:gate-record\n{}\n-->");
    expect(body).toContain("Blast radius: the free shipping check.\nHuman review: required, zone:input (src/api.js).\n\n## Human review required\n\n- `src/api.js` lines 4, 12 (zone:input)");
    expect(body).not.toContain("Ran: everything");
    expect(body.endsWith("## Auditors\n\n- Ran: TDD\n\nCo-Authored using AI\n\n<!-- pipeline:gate-record\n{}\n-->\n")).toBe(true);
  });

  it("puts the generated callouts in Risk after the Human review line and drops a draft's own", () => {
    const parsed = parseDraft(draft.replace("Human review: none.", "Security review: not run for task 9 (mine).\nHuman review: none."));
    const body = assembleBody(parsed, new Map(), ["- Ran: TDD"], "<!-- x -->", [], ["Security review: not run for task 1 (not recorded)."]);
    expect(body).toContain("Human review: none.\nSecurity review: not run for task 1 (not recorded).\n\n## Auditors");
    expect(body).not.toContain("task 9");
  });

  it("writes Human review none without zones", () => {
    expect(humanReviewLine(new Map())).toBe("Human review: none.");
  });
});

// Marks a task done in the ledger, the way its passing check would.
function settle(repo: string, task: string): void {
  const head = git(repo, "rev-parse", "HEAD").stdout.trim();
  const entry = { kind: "task", at: "2026-11-10T10:00:00Z", task, status: "DONE", branch: "main", base: head, head, evidence: "TDD not required: T0 has no TDD gate" };
  write(repo, ".pipeline/work/ship/ledger.jsonl", `${readFileSync(join(repo, ".pipeline/work/ship/ledger.jsonl"), "utf8")}${JSON.stringify(entry)}\n`);
}

describe("pipeline pr-body", () => {
  function shipped(): string {
    const repo = taskRepo();
    brief(repo);
    writeTest(repo);
    pipeline(repo, ["tdd", "red"]);
    fixShipping(repo);
    commitAll(repo);
    pipeline(repo, ["tdd", "green"]);
    write(repo, ".pipeline/task/report.md", "Status: DONE\n\nShips free at 75.\n");
    expect(pipeline(repo, ["task-check"]).status).toBe(0);
    settle(repo, "2");
    write(repo, ".pipeline/work/ship/draft.md", draft);
    return repo;
  }
  const prOf = (repo: string, task: string) =>
    (JSON.parse(readFileSync(join(repo, ".pipeline/work/ship/plan.json"), "utf8")).prs as { name: string; tasks: string[] }[]).find((pr) => pr.tasks.includes(task))!;
  const body = (repo: string, args: string[] = []) => pipeline(repo, ["pr-body", order, "--draft", ".pipeline/work/ship/draft.md", "--range", "HEAD~1..HEAD", "--pr", prOf(repo, "1").name, ...args]);

  it("writes a body that passes pr-check, with Auditors from the gate record and the record hidden at the end", () => {
    const repo = shipped();
    pipeline(repo, ["ledger", "gate", order, "--task", "1", "--gate", "spec", "--result", "pass"]);
    const { status, stdout } = body(repo);
    expect(stdout).toContain("and it passes pr-check");
    expect(stdout).toContain("Title   fix(shipping): ship free at exactly the threshold");
    expect(stdout).toContain("Labels  risk:medium");
    expect(stdout).toContain(`PR      ${prOf(repo, "1").name}`);
    expect(stdout).toContain("Base    HEAD~1");
    expect(status).toBe(0);
    const text = readFileSync(join(repo, `.pipeline/work/ship/pr-${prOf(repo, "1").name}.md`), "utf8");
    expect(text).toContain("- Ran: TDD, spec\n- Skipped: simplifier (task 1: not run), standards (task 1: not run), quick security review (task 1: not run), PR standard (task 2: not run), light security pass (task 2: not run)");
    expect(text).toContain("## How to verify\n\n```\nnode --test\n```");
    expect(text).toContain("Human review: none.");
    expect(text).toMatch(/Co-Authored using AI\n\n<!-- pipeline:gate-record\n\{.*"work":"ship".*\}\n-->\n$/);
  });

  it("adds a callout for each task whose security gate was not recorded, and the body passes pr-check", () => {
    const repo = shipped();
    const { status, stdout } = body(repo);
    expect(status).toBe(0);
    expect(stdout).toContain("passes pr-check");
    const text = readFileSync(join(repo, `.pipeline/work/ship/pr-${prOf(repo, "1").name}.md`), "utf8");
    expect(text).toContain("Human review: none.\nSecurity review: not run for task 1 (not recorded).\nSecurity review: not run for task 2 (not recorded).\n\n## Auditors");
    expect(stdout).toContain("Security review: not run for task 1 (not recorded).");
  });

  it("gives the skip note in the callout and leaves a passed gate out", () => {
    const repo = shipped();
    pipeline(repo, ["ledger", "gate", order, "--task", "1", "--gate", "quick security review", "--result", "skip", "--note", "reviewer not built"]);
    pipeline(repo, ["ledger", "gate", order, "--task", "2", "--gate", "light security pass", "--result", "pass"]);
    const { stdout } = body(repo);
    expect(stdout).toContain("Security review: not run for task 1 (reviewer not built).");
    expect(stdout).not.toContain("task 2 (");
  });

  const asT3 = (repo: string) => {
    const file = join(repo, ".pipeline/work/ship/work-order.md");
    write(repo, ".pipeline/work/ship/work-order.md", readFileSync(file, "utf8").replace("tier: T2", "tier: T3"));
    expect(pipeline(repo, ["schedule", ".pipeline/work/ship/work-order.md"]).status).toBe(0);
  };

  it("refuses a T3 task whose security gate was never recorded, and names the task and gate", () => {
    const repo = shipped();
    asT3(repo);
    const { status, stdout } = body(repo);
    expect(status).toBe(1);
    expect(stdout).toContain("- full security review with verifier vote not recorded for task 1");
  });

  it("refuses a T3 task whose security gate was skipped", () => {
    const repo = shipped();
    asT3(repo);
    pipeline(repo, ["ledger", "gate", order, "--task", "1", "--gate", "full security review with verifier vote", "--result", "skip", "--note", "no time"]);
    const { status, stdout } = body(repo);
    expect(status).toBe(1);
    expect(stdout).toContain("- full security review with verifier vote skipped for task 1 (no time)");
  });

  it("refuses while a gate failed", () => {
    const repo = shipped();
    pipeline(repo, ["ledger", "gate", order, "--task", "1", "--gate", "spec", "--result", "fail"]);
    const { status, stdout } = body(repo);
    expect(status).toBe(1);
    expect(stdout).toContain("- spec failed for task 1");
  });

  it("fails when the draft breaks pr-check, and says why", () => {
    const repo = shipped();
    write(repo, ".pipeline/work/ship/draft.md", draft.replace("The comparison was off by one", "Initially I first tried a cast. The comparison was off by one"));
    const { status, stdout } = body(repo);
    expect(status).toBe(1);
    expect(stdout).toContain("narration");
  });

  it("names zone files from the scan and raises the labels", () => {
    const repo = shipped();
    write(repo, "src/shipping.js", "import { execFile } from 'node:child_process';\nexport const freeShipping = (total) => total >= 75;\nexport const run = (cmd) => execFile(cmd, []);\n");
    commitAll(repo, "fix(shipping): run the hook");
    const { stdout } = pipeline(repo, ["pr-body", order, "--draft", ".pipeline/work/ship/draft.md", "--range", "HEAD~1..HEAD", "--pr", prOf(repo, "1").name]);
    expect(stdout).toMatch(/Labels {2}risk:high, zone:input/);
    expect(readFileSync(join(repo, `.pipeline/work/ship/pr-${prOf(repo, "1").name}.md`), "utf8")).toContain("Human review: required, zone:input (src/shipping.js).");
    expect(git(repo, "status", "--porcelain").stdout).not.toContain("src/");
  });

  it("lists a planned zone's source files for review and leaves its test files out", () => {
    const repo = shipped();
    const file = join(repo, ".pipeline/work/ship/work-order.md");
    write(repo, ".pipeline/work/ship/work-order.md", readFileSync(file, "utf8").replace("zones: []", "zones: [data-loss]"));
    expect(pipeline(repo, ["schedule", ".pipeline/work/ship/work-order.md"]).status).toBe(0);
    body(repo);
    const text = readFileSync(join(repo, `.pipeline/work/ship/pr-${prOf(repo, "1").name}.md`), "utf8");
    expect(text).toContain("Human review: required, zone:data-loss (src/shipping.js).");
    expect(text).not.toContain("test/shipping.test.js");
  });

  it("refuses while a task in the PR is not done", () => {
    const repo = shipped();
    write(repo, ".pipeline/work/ship/ledger.jsonl", readFileSync(join(repo, ".pipeline/work/ship/ledger.jsonl"), "utf8").split("\n")[0] + "\n");
    const { status, stdout } = body(repo);
    expect(status).toBe(1);
    expect(stdout).toContain("- task 2 is not started");
  });

  const review = (repo: string, verb: string) => pipeline(repo, ["review", verb, order, "--task", "1", "--worktree", repo]);
  const say = (repo: string, name: string, value: unknown) =>
    pipeline(repo, ["review", "save", "--hook"], {
      input: JSON.stringify({ last_assistant_message: `Checked.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n\nPackage: ${join(repo, `.pipeline/work/ship/review/task-1/round-1/package-${name}.md`)}` }),
    });
  const boundary = { boundary: "a hook name reaches execFile", file: "src/shipping.js", line: 3, invariant: "only a fixed list of commands runs", tests: ["an unknown command is refused"] };

  // Runs task 1's first round with every reviewer clean but security, which reports what it is given.
  function reviewed(repo: string, hunter: unknown, verdict?: string): void {
    expect(review(repo, "start").status).toBe(0);
    for (const name of ["simplifier", "spec", "standards"]) say(repo, name, { findings: [] });
    say(repo, "security-hunter-1", hunter);
    review(repo, "merge");
    if (verdict) {
      say(repo, "security-verifier-1", { verdicts: [{ candidate: "security-1.1", verdict, reason: "Checked against HEAD." }] });
      review(repo, "merge");
    }
  }

  // Adds zone code to task 1 and passes its check again.
  function zoned(repo: string): void {
    write(repo, "src/shipping.js", "import { execFile } from 'node:child_process';\nexport const freeShipping = (total) => total >= 75;\nexport const run = (cmd) => execFile(cmd, []);\n");
    commitAll(repo, "fix(shipping): run the hook");
    expect(pipeline(repo, ["tdd", "green"]).status).toBe(0);
    expect(pipeline(repo, ["task-check"]).status).toBe(0);
  }

  it("refuses while an Important security finding is open", () => {
    const repo = shipped();
    const hole = { file: "src/shipping.js", line: 1, title: "Anyone can change the threshold", boundary: "visitor to settings", result: "every order ships free", severity: "high", fix: "Check the capability.", tests: ["a subscriber is denied"] };
    reviewed(repo, { findings: [hole] }, "confirmed");
    const { status, stdout } = body(repo);
    expect(status).toBe(1);
    expect(stdout).toContain("- quick security review failed for task 1");
  });

  it("refuses when the security pass is older than the task's head", () => {
    const repo = shipped();
    reviewed(repo, { findings: [] });
    zoned(repo);
    const { status, stdout } = body(repo);
    expect(status).toBe(1);
    expect(stdout).toMatch(/- quick security review passed for task 1 at [0-9a-f]{7}, and the task is at [0-9a-f]{7}, so review it again/);
  });

  it("puts the security review guide in Human review required for a zone PR", () => {
    const repo = shipped();
    zoned(repo);
    reviewed(repo, { findings: [], boundaries: [boundary] });
    expect(body(repo).status).toBe(0);
    const text = readFileSync(join(repo, `.pipeline/work/ship/pr-${prOf(repo, "1").name}.md`), "utf8");
    expect(text.split("Human review required\n\n")[1]).toMatch(/^- `src\/shipping.js` lines [\d, ]+ \(zone:input\)\n\nSecurity review guide, task 1:\n\n- Read first: `src\/shipping.js` line 3\n- Boundary: a hook name reaches execFile at `src\/shipping.js:3`\. Invariant: only a fixed list of commands runs\. Tests: an unknown command is refused\./);
    expect(text).toMatch(/- Ran: [^\n]*quick security review/);
  });

  it("needs a draft with a title", () => {
    const repo = shipped();
    write(repo, ".pipeline/work/ship/draft.md", draft.replace(/^Title:.*\n/, ""));
    expect(body(repo).stderr).toContain("no `Title:` line");
  });
});
