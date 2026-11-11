import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderFixList } from "../../src/review/merge.ts";
import { renderHunterPackage } from "../../src/review/package.ts";
import { securityPlan, tally, validateHunter, validateVerdicts } from "../../src/review/security.ts";
import type { Round } from "../../src/review/state.ts";
import type { TaskRecord } from "../../src/task/record.ts";
import { git, pipeline, removeTemps, write } from "../helpers/repo.ts";
import { brief, commitAll, fixShipping, taskRepo } from "../task/fixture.ts";

afterAll(removeTemps);

const order = ".pipeline/work/ship/work-order.md";
const longTest = Array.from({ length: 15 }, (_, index) => `// Case ${index}: an order at the threshold ships free.`).join("\n");

function checked(repo: string): void {
  const result = pipeline(repo, ["task-check"]);
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
}

// A built and checked task 1 at the given tier.
function shipped(tier = "T2"): string {
  const repo = taskRepo();
  if (tier !== "T2") {
    write(repo, order, readFileSync(join(repo, order), "utf8").replace("tier: T2", `tier: ${tier}`));
    expect(pipeline(repo, ["schedule", order]).status).toBe(0);
  }
  brief(repo);
  write(repo, "test/shipping.test.js", `${longTest}\n`);
  expect(pipeline(repo, ["tdd", "red"]).status).toBe(0);
  fixShipping(repo);
  commitAll(repo);
  expect(pipeline(repo, ["tdd", "green"]).status).toBe(0);
  write(repo, ".pipeline/task/report.md", "Status: DONE\n\nAn order of exactly 75 ships free.\n");
  checked(repo);
  return repo;
}

function fix(repo: string, content: string): void {
  write(repo, "src/shipping.js", content);
  commitAll(repo, "fix(shipping): address review");
  expect(pipeline(repo, ["tdd", "green"]).status).toBe(0);
  checked(repo);
}

const review = (repo: string, verb: string, args: string[] = []) => pipeline(repo, ["review", verb, order, "--task", "1", "--worktree", repo, ...args]);
const roundFile = (repo: string, name: string, round = 1) => join(repo, `.pipeline/work/ship/review/task-1/round-${round}/${name}`);
const say = (repo: string, name: string, value: unknown, round = 1) =>
  pipeline(repo, ["review", "save", "--hook"], {
    input: JSON.stringify({ hook_event_name: "SubagentStop", last_assistant_message: `Checked.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n\nPackage: ${roundFile(repo, `package-${name}.md`, round)}` }),
  });
const ledger = (repo: string) =>
  readFileSync(join(repo, ".pipeline/work/ship/ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const head = (repo: string) => git(repo, "rev-parse", "HEAD").stdout.trim();

const hole = {
  file: "src/shipping.js",
  line: 1,
  title: "Any visitor can set the free shipping threshold",
  boundary: "an anonymous request reaches the threshold setter",
  result: "a visitor ships every order free",
  severity: "high",
  fix: "Check the shop manager capability before the setter runs.",
  tests: ["a subscriber is denied", "a logged-out request is rejected"],
};
const leak = { ...hole, line: 1, title: "The debug log prints customer emails", boundary: "server log to support staff", result: "staff read customer emails", severity: "medium", tests: ["the log holds no email"] };
const unsure = { file: "src/shipping.js", line: 1, title: "The threshold may come from a query string", boundary: "request to pricing", fact: "whether the theme passes $_GET into freeShipping" };
const route = { boundary: "checkout request to the free shipping check", file: "src/shipping.js", line: 1, invariant: "only the order total decides free shipping", tests: ["an order of 75 ships free"] };

// The other reviewers of a round, replied empty.
function othersReply(repo: string, round = 1, names = ["simplifier", "spec", "standards"]): void {
  for (const name of names) expect(say(repo, name, { findings: [] }, round).stdout).toBe("");
}

describe("security depth", () => {
  it("reads the depth from the tier's gate", () => {
    expect(securityPlan(["PR standard", "light security pass"])).toEqual({ gate: "light security pass", depth: "light", hunters: 1, verifiers: 1, model: "sonnet" });
    expect(securityPlan(["TDD", "quick security review"])).toEqual({ gate: "quick security review", depth: "quick", hunters: 1, verifiers: 1, model: "sonnet" });
    expect(securityPlan(["full security review with verifier vote"])).toEqual({ gate: "full security review with verifier vote", depth: "full", hunters: 3, verifiers: 3, model: "opus" });
    expect(securityPlan(["spec"])).toBeNull();
  });
});

describe("validateHunter and validateVerdicts", () => {
  it("takes a finding with its boundary, result, anchored severity and tests, and names what is missing", () => {
    expect(validateHunter({ findings: [hole], needs_validation: [unsure], boundaries: [route] }, []).problems).toEqual([]);
    const { problems } = validateHunter({ findings: [{ ...hole, boundary: "", severity: "severe", tests: [] }] }, []);
    expect(problems.join("\n")).toMatch(/"boundary"[\s\S]*severity "severe"[\s\S]*"tests"/);
    expect(validateHunter({ findings: [{ ...hole, result: undefined }] }, []).problems[0]).toContain('"result"');
    expect(validateHunter({ findings: [{ ...hole, tag: "Nit" }] }, []).problems[0]).toContain("Important or Pre-existing");
    expect(validateHunter({ findings: [{ ...hole, id: "security-1.4" }] }, ["security-1.1"]).problems[0]).toContain("none of your open findings");
  });

  it("keeps severity off a needs_validation entry and needs its exact fact", () => {
    expect(validateHunter({ findings: [], needs_validation: [{ ...unsure, severity: "high" }] }, []).problems[0]).toContain("carries no severity");
    expect(validateHunter({ findings: [], needs_validation: [{ ...unsure, fact: "" }] }, []).problems[0]).toContain('"fact"');
  });

  it("needs one verdict with a reason per candidate, and a fact for needs_validation", () => {
    const ids = ["security-1.1", "security-1.2"];
    expect(validateVerdicts({ verdicts: [{ candidate: "security-1.1", verdict: "confirmed", reason: "No check." }, { candidate: "security-1.2", verdict: "needs_validation", reason: "Depends on the theme.", fact: "whether the theme filters it" }] }, ids).problems).toEqual([]);
    const { problems } = validateVerdicts({ verdicts: [{ candidate: "security-1.1", verdict: "maybe", reason: "" }, { candidate: "security-1.9", verdict: "rejected", reason: "x" }] }, ids);
    expect(problems.join("\n")).toMatch(/verdict "maybe"[\s\S]*"reason"[\s\S]*security-1\.9[\s\S]*no verdict for security-1\.2/);
    expect(validateVerdicts({ verdicts: [{ candidate: "security-1.1", verdict: "needs_validation", reason: "x" }, { candidate: "security-1.2", verdict: "rejected", reason: "x" }] }, ids).problems[0]).toContain('"fact"');
  });
});

describe("tally", () => {
  const candidate = { ...hole, id: "security-1.1", tag: "Important" as const, tests: hole.tests, severity: "high" as const };
  it("confirms on a majority of verifiers, and leaves a split unresolved", () => {
    const vote = (...verdicts: string[]) => verdicts.map((verdict) => [{ candidate: "security-1.1", verdict, reason: `${verdict}.`, ...(verdict === "needs_validation" ? { fact: "the theme" } : {}) }]);
    expect(tally([candidate], vote("confirmed", "confirmed", "rejected") as never).confirmed.map((entry) => entry.id)).toEqual(["security-1.1"]);
    expect(tally([candidate], vote("confirmed", "rejected", "rejected") as never).rejected.map((entry) => entry.id)).toEqual(["security-1.1"]);
    expect(tally([candidate], vote("confirmed", "rejected", "needs_validation") as never).unresolved.map((entry) => entry.title)).toEqual([candidate.title]);
    expect(tally([candidate], vote("rejected") as never).rejected[0]!.reasons).toEqual(["rejected."]);
  });
});

describe("renderFixList", () => {
  it("hands a task with no suite its security tests as checks for the human", () => {
    const merged = { head: "abc", accepted: [{ ...hole, id: "security-1.1", reviewer: "security" as const, axis: "security" as const, tag: "Important" as const, detail: hole.result }], backlog: [], duplicates: [], contests: [], fixed: [], opened: 1 };
    const list = renderFixList(merged, "1", 1, "/w", false);
    expect(list).toContain("The task has no suite, so the review guide lists these as checks for the human:");
    expect(list).not.toContain("pipeline tdd red");
  });
});

describe("pipeline review start with security", () => {
  it("dispatches one sonnet hunter beside the other reviewers for a quick review", () => {
    const repo = shipped();
    const { status, stdout } = review(repo, "start");
    expect(status).toBe(0);
    expect(stdout).toContain(`Dispatch  dev-pipeline:security-hunter with ${roundFile(repo, "package-security-hunter-1.md")}`);
    expect(stdout).toContain("Why       security: the first round reviews the whole diff");
    expect(stdout).not.toContain("ships in 3.1");
    const pkg = readFileSync(roundFile(repo, "package-security-hunter-1.md"), "utf8");
    expect(pkg).toContain("quick");
    expect(pkg).toContain("An order of exactly 75 ships free.");
    expect(pkg).toContain("Package: ");
  });

  it("dispatches three hunters on opus for a full review", () => {
    const repo = shipped("T3");
    const { stdout } = review(repo, "start");
    for (const n of [1, 2, 3]) expect(stdout).toContain(`Dispatch  dev-pipeline:security-hunter on opus with ${roundFile(repo, `package-security-hunter-${n}.md`)}`);
  });

  it("gives a light pass its short checklist", () => {
    const round = { task: "2", round: 1, scope: "full", from: "abc", base: "abc", reasons: {}, zoneFiles: [], security: { ...securityPlan(["light security pass"])!, from: "abc", php: false } } as unknown as Round;
    const record = { workOrder: "/w/.pipeline/work/ship/work-order.md", worktree: "/w", files: ["README.md"], tier: "T0", zones: [] } as unknown as TaskRecord;
    const pkg = renderHunterPackage(1, round, record, "## Task 2: Shipping copy", []);
    expect(pkg).toContain("Depth        light");
    for (const item of ["Secrets and keys", "External URLs and loads", "Tracking", "Exposed data", "Configuration values"]) expect(pkg).toContain(item);
    expect(pkg).toContain("Package: /w/.pipeline/work/ship/review/task-2/round-1/package-security-hunter-1.md");
  });

  it("hands the hunters the WordPress companion when the diff holds PHP", () => {
    const repo = shipped();
    write(repo, "src/settings.php", "<?php\nregister_rest_route( 'shop/v1', '/threshold', array( 'permission_callback' => '__return_true' ) );\n");
    write(repo, ".pipeline/task/report.md", "Status: DONE\n\nUnplanned: src/settings.php registers the threshold route.\n");
    commitAll(repo, "feat(shipping): add the threshold route");
    expect(pipeline(repo, ["tdd", "green"]).status).toBe(0);
    checked(repo);
    review(repo, "start");
    expect(readFileSync(roundFile(repo, "package-security-hunter-1.md"), "utf8")).toContain(`read the WordPress companion at ${roundFile(repo, "wordpress-security.md")}`);
    expect(readFileSync(roundFile(repo, "wordpress-security.md"), "utf8")).toContain("permission_callback");
  });

  it("reprints only the reviewers that have not replied", () => {
    const repo = shipped();
    review(repo, "start");
    othersReply(repo);
    const { stdout } = review(repo, "start");
    expect(stdout).toContain("dev-pipeline:security-hunter");
    expect(stdout).not.toContain("Dispatch  dev-pipeline:spec-reviewer");
  });
});

describe("pipeline review merge with security", () => {
  it("fails the gate closed while a hunter has not replied", () => {
    const repo = shipped();
    review(repo, "start");
    othersReply(repo);
    const { status, stderr } = review(repo, "merge");
    expect(status).toBe(1);
    expect(stderr).toContain("no findings yet from security-hunter-1");
    expect(ledger(repo)).toContainEqual(expect.objectContaining({ kind: "gate", gate: "quick security review", result: "fail", head: head(repo) }));
  });

  it("passes the gate at the head SHA when the hunter finds nothing, with no verifier", () => {
    const repo = shipped();
    review(repo, "start");
    othersReply(repo);
    expect(say(repo, "security-hunter-1", { findings: [], boundaries: [route] }).stdout).toBe("");
    const { status, stdout } = review(repo, "merge");
    expect(status).toBe(0);
    expect(stdout).not.toContain("Verify");
    expect(stdout).toContain("Gate      quick security review pass");
    expect(ledger(repo)).toContainEqual(expect.objectContaining({ kind: "gate", gate: "quick security review", result: "pass", head: head(repo) }));
  });

  it("stops for verification, then keeps a confirmed candidate as an Important security finding with its tests red first", () => {
    const repo = shipped();
    review(repo, "start");
    othersReply(repo);
    say(repo, "security-hunter-1", { findings: [hole], boundaries: [route] });
    const first = review(repo, "merge");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(`Verify    dev-pipeline:security-verifier with ${roundFile(repo, "package-security-verifier-1.md")}`);
    expect(existsSync(roundFile(repo, "merged.json"))).toBe(false);
    const pkg = readFileSync(roundFile(repo, "package-security-verifier-1.md"), "utf8");
    expect(pkg).toContain('"id": "security-1.1"');
    expect(pkg).not.toContain("hunter-1");
    expect(ledger(repo)).toContainEqual(expect.objectContaining({ gate: "quick security review", result: "fail" }));

    expect(say(repo, "security-verifier-1", { verdicts: [{ candidate: "security-1.1", verdict: "confirmed", reason: "Nothing checks the caller." }] }).stdout).toBe("");
    const second = review(repo, "merge");
    expect(second.stdout).toContain("1 to fix (security 1)");
    expect(second.stdout).toContain("Gate      quick security review fail, 1 open");
    const list = readFileSync(roundFile(repo, "fix-list.md"), "utf8");
    expect(list).toContain("`security-1.1` security, Important, high, src/shipping.js:1");
    expect(list).toContain("Boundary: an anonymous request reaches the threshold setter");
    expect(list).toMatch(/red first[\s\S]*- a subscriber is denied\n {3}- a logged-out request is rejected/);
    expect(review(repo, "dismiss", ["--finding", "security-1.1", "--reason", "low risk"]).stderr).toContain("only a peer reviewer can accept");
  });

  it("sends rejected and needs_validation candidates to the review guide, not the fix list", () => {
    const repo = shipped("T3");
    review(repo, "start");
    othersReply(repo);
    say(repo, "security-hunter-1", { findings: [hole], needs_validation: [unsure], boundaries: [route] });
    say(repo, "security-hunter-2", { findings: [{ ...hole, title: "Visitors can set the free shipping threshold" }, leak] });
    say(repo, "security-hunter-3", { findings: [] });
    expect(review(repo, "merge").stdout).toContain(`Verify    dev-pipeline:security-verifier with ${roundFile(repo, "package-security-verifier-3.md")}`);
    const candidates = JSON.parse(readFileSync(roundFile(repo, "candidates.json"), "utf8")).candidates;
    expect(candidates.map((entry: { id: string }) => entry.id)).toEqual(["security-1.1", "security-1.2"]);
    const verdicts = (first: string, second: string) => ({
      verdicts: [
        { candidate: "security-1.1", verdict: first, reason: `${first} by the vote.` },
        { candidate: "security-1.2", verdict: second, reason: "The log is local only." },
      ],
    });
    say(repo, "security-verifier-1", verdicts("rejected", "rejected"));
    say(repo, "security-verifier-2", verdicts("rejected", "confirmed"));
    say(repo, "security-verifier-3", verdicts("confirmed", "rejected"));
    const { stdout } = review(repo, "merge");
    expect(stdout).toContain("Gate      full security review with verifier vote pass");
    expect(existsSync(roundFile(repo, "fix-list.md"))).toBe(false);
    const guide = readFileSync(join(repo, ".pipeline/work/ship/review/task-1/guide.md"), "utf8");
    expect(guide).toContain("- Read first: `src/shipping.js` line 1");
    expect(guide).toContain("- Boundary: checkout request to the free shipping check at `src/shipping.js:1`. Invariant: only the order total decides free shipping. Tests: an order of 75 ships free.");
    expect(guide).toContain("- Unresolved: The threshold may come from a query string at `src/shipping.js:1`. Needs: whether the theme passes $_GET into freeShipping.");
    expect(guide).toMatch(/<details>\n<summary>Rejected candidates \(2\)<\/summary>\n\n- Any visitor can set the free shipping threshold at `src\/shipping.js:1`: rejected by the vote\.[\s\S]*<\/details>/);
  });

  it("fails the gate closed when a reply fails validation twice", () => {
    const repo = shipped();
    review(repo, "start");
    const bad = { findings: [{ ...hole, severity: "huge" }] };
    expect(JSON.parse(say(repo, "security-hunter-1", bad).stdout).decision).toBe("block");
    const second = JSON.parse(say(repo, "security-hunter-1", bad).stdout);
    expect(second.decision).toBeUndefined();
    expect(second.systemMessage).toContain("failed the security gate");
    expect(ledger(repo)).toContainEqual(expect.objectContaining({ kind: "gate", gate: "quick security review", result: "fail", note: "round 1, security-hunter-1's reply failed validation twice" }));
  });
});

describe("security fix rounds", () => {
  function confirmed(repo: string): void {
    review(repo, "start");
    othersReply(repo);
    say(repo, "security-hunter-1", { findings: [hole] });
    review(repo, "merge");
    say(repo, "security-verifier-1", { verdicts: [{ candidate: "security-1.1", verdict: "confirmed", reason: "No check." }] });
    review(repo, "merge");
  }

  it("reruns security on every fix, and closes the finding the hunters stop reporting", () => {
    const repo = shipped();
    confirmed(repo);
    fix(repo, "export const freeShipping = (total) => total >= 75; // checked\n");
    const { stdout } = review(repo, "start");
    expect(stdout).toContain("round 2 (fix)");
    expect(stdout).toContain("Dispatch  dev-pipeline:security-hunter");
    expect(stdout).toContain("Why       security: security re-reviews every fix");
    expect(readFileSync(roundFile(repo, "package-security-hunter-1.md", 2), "utf8")).toContain('"id": "security-1.1"');
    say(repo, "security-hunter-1", { findings: [] }, 2);
    const merged = review(repo, "merge");
    expect(merged.stdout).toContain("1 fixed");
    expect(merged.stdout).toContain("Gate      quick security review pass");
  });

  it("reads the whole task diff when the fix touches zone code", () => {
    const repo = shipped();
    confirmed(repo);
    const base = JSON.parse(readFileSync(join(repo, ".pipeline/task/task.json"), "utf8")).base;
    fix(repo, "import { execFile } from 'node:child_process';\nexport const freeShipping = (total) => total >= 75;\nexport const run = (cmd) => execFile(cmd, []);\n");
    const { stdout } = review(repo, "start");
    expect(stdout).toContain("security: the fix touches zone code in src/shipping.js, so security reads the whole task diff");
    expect(readFileSync(roundFile(repo, "package-security-hunter-1.md", 2), "utf8")).toContain(`diff ${base}..HEAD`);
  });

  it("opens a security round when HEAD moves after a clean pass", () => {
    const repo = shipped();
    review(repo, "start");
    othersReply(repo);
    say(repo, "security-hunter-1", { findings: [] });
    review(repo, "merge");
    fix(repo, "export const freeShipping = (total) => total >= 75; // later\n");
    const { stdout } = review(repo, "start");
    expect(stdout).toContain("round 2");
    expect(stdout).toContain("dev-pipeline:security-hunter");
  });
});
