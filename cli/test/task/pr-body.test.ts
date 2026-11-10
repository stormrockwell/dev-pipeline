import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { auditors, type RecordJson } from "../../src/commands/pr-body/auditors.ts";
import { assembleBody, humanReviewLine, parseDraft } from "../../src/commands/pr-body/body.ts";
import { git, pipeline, removeTemps, write } from "../helpers/repo.ts";
import { brief, commitAll, fixShipping, taskRepo, writeTest } from "./fixture.ts";

afterAll(removeTemps);

const order = ".pipeline/work/ship/work-order.md";

const draft = `Title: fix(shipping): ship free at exactly the threshold

## What changed

- An order of exactly 75 now ships free.

## Why this approach

The comparison was off by one, so it now includes the threshold.

## How to verify

\`\`\`
node --test
\`\`\`

## Risk

Door: two-way.
Blast radius: the free shipping check.
Human review: none.

## Auditors

- Ran: everything

Co-Authored using AI
`;

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
    expect(status).toBe(0);
    const text = readFileSync(join(repo, `.pipeline/work/ship/pr-${prOf(repo, "1").name}.md`), "utf8");
    expect(text).toContain("- Ran: TDD, spec\n- Skipped: simplifier (task 1: not run), standards (task 1: not run), quick security review (task 1: not run), PR standard (task 2: not run), light security pass (task 2: not run)");
    expect(text).toContain("## How to verify\n\n```\nnode --test\n```");
    expect(text).toContain("Human review: none.");
    expect(text).toMatch(/Co-Authored using AI\n\n<!-- pipeline:gate-record\n\{.*"work":"ship".*\}\n-->\n$/);
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

  it("refuses while a task in the PR is not done", () => {
    const repo = shipped();
    write(repo, ".pipeline/work/ship/ledger.jsonl", readFileSync(join(repo, ".pipeline/work/ship/ledger.jsonl"), "utf8").split("\n")[0] + "\n");
    const { status, stdout } = body(repo);
    expect(status).toBe(1);
    expect(stdout).toContain("- task 2 is not started");
  });

  it("needs a draft with a title", () => {
    const repo = shipped();
    write(repo, ".pipeline/work/ship/draft.md", draft.replace(/^Title:.*\n/, ""));
    expect(body(repo).stderr).toContain("no `Title:` line");
  });
});
