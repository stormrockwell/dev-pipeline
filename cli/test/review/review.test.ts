import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pipeline, removeTemps, tempDir, write } from "../helpers/repo.ts";
import { brief, commitAll, fixShipping, taskRepo } from "../task/fixture.ts";

afterAll(removeTemps);

const order = ".pipeline/work/ship/work-order.md";

// A test file long enough that a one-line fix stays under a third of the task's diff.
const longTest = Array.from({ length: 15 }, (_, index) => `// Case ${index}: an order at the threshold ships free.`).join("\n");

function checked(repo: string): void {
  const result = pipeline(repo, ["task-check"]);
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
}

function shipped(): string {
  const repo = taskRepo();
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

// Commits a change, then reaches green and passes the check, as the implementer's fix pass does.
function fix(repo: string, content: string, message = "fix(shipping): address review"): void {
  write(repo, "src/shipping.js", content);
  commitAll(repo, message);
  expect(pipeline(repo, ["tdd", "green"]).status).toBe(0);
  checked(repo);
}

const review = (repo: string, verb: string, args: string[] = []) => pipeline(repo, ["review", verb, order, "--task", "1", "--worktree", repo, ...args]);
const pkg = (repo: string, reviewer: string, round = 1) => join(repo, `.pipeline/work/ship/review/task-1/round-${round}/package-${reviewer}.md`);
const reply = (repo: string, reviewer: string, findings: unknown[], round = 1) =>
  pipeline(repo, ["review", "save", "--hook"], {
    input: JSON.stringify({ hook_event_name: "SubagentStop", last_assistant_message: `Reviewed.\n\n\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\`\n\nPackage: ${pkg(repo, reviewer, round)}` }),
  });
const ledger = (repo: string) =>
  readFileSync(join(repo, ".pipeline/work/ship/ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

const strict = { axis: "correctness", tag: "Important", file: "src/shipping.js", line: 1, title: "Wholesale orders lose free shipping", detail: "The task says every order type.", fix: "Cover wholesale." };
const inline = { axis: "readability", tag: "Nit", file: "src/shipping.js", line: 1, title: "Inline the threshold constant", detail: "One use." };

function firstRound(repo: string, spec: unknown[] = [strict], simplifier: unknown[] = [], standards: unknown[] = []) {
  expect(review(repo, "start").status).toBe(0);
  for (const [reviewer, findings] of [["simplifier", simplifier], ["spec", spec], ["standards", standards]] as const) expect(reply(repo, reviewer, findings).stdout).toBe("");
  return review(repo, "merge");
}

describe("pipeline review start", () => {
  it("waits for a passing check at HEAD", () => {
    const repo = taskRepo();
    brief(repo);
    const { status, stderr } = review(repo, "start");
    expect(status).toBe(1);
    expect(stderr).toContain("run `pipeline task-check");
  });

  it("opens a full first round with a package per reviewer, simplifier first, and skips the security gate", () => {
    const repo = shipped();
    const { status, stdout } = review(repo, "start");
    expect(status).toBe(0);
    expect(stdout).toContain("round 1 (full)");
    expect(stdout).toContain("Order     the simplifier first, and the rest at once when it returns");
    for (const agent of ["simplifier", "spec-reviewer", "standards-reviewer"]) expect(stdout).toContain(`Dispatch  dev-pipeline:${agent} with`);
    expect(stdout).toContain("Skipped   quick security review: the security reviewer ships in 3.1");
    expect(readFileSync(pkg(repo, "spec"), "utf8")).toContain("An order of exactly 75 ships free.");
    expect(readFileSync(pkg(repo, "standards"), "utf8")).toContain("pipeline review files --task");
    expect(ledger(repo)).toContainEqual(expect.objectContaining({ kind: "gate", gate: "quick security review", result: "skip" }));
    expect(review(repo, "start").stdout).toBe(stdout);
  });
});

describe("pipeline review save --hook", () => {
  it("sends back a reply whose findings break the schema, and one with no package line", () => {
    const repo = shipped();
    review(repo, "start");
    const bad = JSON.parse(reply(repo, "simplifier", [{ ...strict, axis: "correctness" }]).stdout);
    expect(bad.decision).toBe("block");
    expect(bad.reason).toContain("simplifier reports readability");
    const none = pipeline(repo, ["review", "save", "--hook"], { input: JSON.stringify({ last_assistant_message: "Done." }) });
    expect(JSON.parse(none.stdout).reason).toContain("Package: <path>");
  });
});

describe("pipeline review merge", () => {
  it("needs every reviewer's findings", () => {
    const repo = shipped();
    review(repo, "start");
    reply(repo, "spec", []);
    const { status, stderr } = review(repo, "merge");
    expect(status).toBe(1);
    expect(stderr).toContain("no findings yet from simplifier, standards");
  });

  it("writes the fix list in precedence order and records each reviewer's gate", () => {
    const repo = shipped();
    const { status, stdout } = firstRound(repo, [strict], [], [{ ...inline, axis: "style", title: "Use a named export", line: 1 }]);
    expect(status).toBe(0);
    expect(stdout).toContain("2 to fix (correctness 1, style 1)");
    expect(stdout).toContain("Gate      spec fail, 1 open");
    expect(stdout).toContain("Gate      simplifier pass");
    const list = readFileSync(join(repo, ".pipeline/work/ship/review/task-1/round-1/fix-list.md"), "utf8");
    expect(list.indexOf("spec-1.1")).toBeLessThan(list.indexOf("standards-1.1"));
    expect(ledger(repo)).toContainEqual(expect.objectContaining({ kind: "round", round: 1, scope: "full", opened: 2, fixed: 0 }));
  });

  it("names a contest between axes, and overrules only in precedence's direction", () => {
    const repo = shipped();
    const { stdout } = firstRound(repo, [strict], [inline]);
    expect(stdout).toContain("Contest   spec-1.1 (correctness) and simplifier-1.1 (readability) both change src/shipping.js:1");
    expect(review(repo, "overrule", ["--finding", "spec-1.1", "--over", "simplifier-1.1"]).status).toBe(1);
    const ruled = review(repo, "overrule", ["--finding", "simplifier-1.1", "--over", "spec-1.1"]);
    expect(ruled.status).toBe(0);
    expect(ruled.stdout).toContain("1 to fix (correctness 1)");
    const entries = ledger(repo);
    expect(entries).toContainEqual(expect.objectContaining({ kind: "ruling", why: "correctness outranks readability, and the two pull the same lines in opposite directions" }));
    expect(entries).toContainEqual(expect.objectContaining({ kind: "accepted", gate: "simplifier", finding: "simplifier-1.1: Inline the threshold constant" }));
  });

  it("waives a finding with its reason, which the gate record carries", () => {
    const repo = shipped();
    firstRound(repo, [strict]);
    const { status, stdout } = review(repo, "dismiss", ["--finding", "spec-1.1", "--reason", "wholesale is out of scope per the work order"]);
    expect(status).toBe(0);
    expect(stdout).toContain("no open findings, so review is done");
    const record = JSON.parse(pipeline(repo, ["gate-record", order, "--json"]).stdout);
    expect(record.accepted).toEqual([{ task: "1", gate: "spec", finding: "spec-1.1: Wholesale orders lose free shipping", reason: "wholesale is out of scope per the work order" }]);
    expect(record.findings).toEqual({ opened: 1, fixed: 0, accepted: 1 });
    expect(record.gates).toContainEqual({ task: "1", gate: "spec", result: "pass", note: "round 1, no open findings" });
  });
});

describe("fix rounds", () => {
  it("routes a fix on the named lines to the reviewer whose finding it fixes, and closes when it is fixed", () => {
    const repo = shipped();
    firstRound(repo, [strict]);
    expect(review(repo, "start").stderr).toContain("no commits since round 1 merged");
    fix(repo, "export const freeShipping = (total, wholesale = false) => wholesale || total >= 75;\n");
    const started = review(repo, "start");
    expect(started.stdout).toContain("round 2 (fix)");
    expect(started.stdout).toContain("Dispatch  dev-pipeline:spec-reviewer");
    expect(started.stdout).not.toContain("standards-reviewer");
    expect(started.stdout).toContain("Why       spec: checks whether the fix addressed spec-1.1");
    expect(readFileSync(pkg(repo, "spec", 2), "utf8")).toContain('"id": "spec-1.1"');
    expect(reply(repo, "spec", [], 2).stdout).toBe("");
    const merged = review(repo, "merge");
    expect(merged.stdout).toContain("0 to fix, 1 fixed");
    expect(review(repo, "start").stdout).toContain("every gate passed in round 2");
    expect(JSON.parse(pipeline(repo, ["gate-record", order, "--json"]).stdout).findings).toEqual({ opened: 1, fixed: 1, accepted: 0 });
  });

  it("adds the simplifier and standards when the fix adds a branch, and spec when it changes other lines", () => {
    const repo = shipped();
    firstRound(repo, [], [], [{ ...inline, axis: "style", title: "Name the threshold" }]);
    fix(repo, "export const freeShipping = (total) => {\n  if (total >= 75) return true;\n  return false;\n};\n");
    const { stdout } = review(repo, "start");
    expect(stdout).toContain("round 2 (fix)");
    expect(stdout).toMatch(/Why {7}simplifier: the fix adds a function or branch/);
    expect(stdout).toContain("Why       standards: checks whether the fix addressed standards-1.1");
    expect(stdout).not.toContain("spec-reviewer");
  });

  it("adds spec when the fix changes code far from every named line", () => {
    const repo = taskRepo();
    brief(repo);
    write(repo, "test/shipping.test.js", `${longTest}\n`);
    pipeline(repo, ["tdd", "red"]);
    const body = (last: string) => ["export const freeShipping = (total) => total >= 75;", ...Array.from({ length: 18 }, (_, index) => `// Note ${index}.`), last, ""].join("\n");
    write(repo, "src/shipping.js", body("export const label = 'Free shipping';"));
    commitAll(repo);
    pipeline(repo, ["tdd", "green"]);
    write(repo, ".pipeline/task/report.md", "Status: DONE\n");
    checked(repo);
    firstRound(repo, [], [], [{ ...inline, axis: "style", title: "Name the threshold" }]);
    fix(repo, body("export const label = 'Ships free';"));
    const { stdout } = review(repo, "start");
    expect(stdout).toContain("round 2 (fix)");
    expect(stdout).toContain("Why       spec: the fix changes src/shipping.js near line 20, beyond the lines a finding named");
    expect(stdout).not.toContain("simplifier:");
  });

  it("makes a fix that adds a file a full round", () => {
    const repo = shipped();
    firstRound(repo, [strict]);
    write(repo, "src/wholesale.js", "export const wholesale = true;\n");
    write(repo, ".pipeline/task/report.md", "Status: DONE\n\nUnplanned: src/wholesale.js holds the wholesale flag.\n");
    fix(repo, "export const freeShipping = (total) => total >= 75;\n// Wholesale ships free.\n");
    const { stdout } = review(repo, "start");
    expect(stdout).toContain("round 2 (full)");
    expect(stdout).toContain("the fix adds src/wholesale.js, so it counts as new code");
  });

  it("stops after three rounds until the developer says go on", () => {
    const repo = shipped();
    firstRound(repo, [strict]);
    for (const round of [2, 3]) {
      fix(repo, `export const freeShipping = (total) => total >= 75; // round ${round}\n`);
      review(repo, "start");
      reply(repo, "spec", [{ ...strict, id: "spec-1.1" }], round);
      review(repo, "merge");
    }
    fix(repo, "export const freeShipping = (total) => total >= 75; // round 4\n");
    const capped = review(repo, "start");
    expect(capped.status).toBe(1);
    expect(capped.stderr).toContain("ask the developer whether the approach needs rethinking");
    expect(review(repo, "start", ["--continue", "the developer wants one more pass"]).status).toBe(0);
    expect(ledger(repo)).toContainEqual(expect.objectContaining({ kind: "ruling", decided: "Ran review round 4 past the 3-round cap", why: "the developer wants one more pass" }));
  });
});

describe("pipeline review files", () => {
  it("serves the vendored OCR rules when ocr is missing", () => {
    const repo = shipped();
    const base = JSON.parse(readFileSync(join(repo, ".pipeline/task/task.json"), "utf8")).base;
    const { status, stdout } = pipeline(repo, ["review", "files", "--task", repo, "--from", base], { env: { PIPELINE_OCR: join(repo, "no-ocr") } });
    expect(status).toBe(0);
    expect(stdout).toContain("Files and rules from vendored OCR 1.13.3 rules.");
    expect(stdout).toContain("- src/shipping.js (modified)");
    expect(stdout).toContain("#### Dead Code");
  });

  it("maps OCR's delegate JSON when ocr runs", () => {
    const repo = shipped();
    const fake = join(tempDir(), "ocr");
    write(
      fake.replace(/\/ocr$/, ""),
      "ocr",
      [
        "#!/bin/sh",
        'if [ "$2" = preview ]; then',
        `  echo '{"schema_version":"1","reviewable_files":[{"path":"src/shipping.js","status":"modified"}],"excluded_files":[{"path":"package-lock.json","exclude_reason":"lockfile"}]}'`,
        "else",
        `  echo '{"schema_version":"1","groups":[{"group_id":1,"files":["src/shipping.js"],"rule":"Check the threshold."}]}'`,
        "fi",
      ].join("\n"),
    );
    chmodSync(fake, 0o755);
    const { stdout } = pipeline(repo, ["review", "files", "--task", repo, "--from", "HEAD~1", "--json"], { env: { PIPELINE_OCR: fake } });
    expect(JSON.parse(stdout)).toEqual({
      source: "ocr 1.13.3 delegation",
      files: [{ path: "src/shipping.js", status: "modified" }],
      excluded: [{ path: "package-lock.json", reason: "lockfile" }],
      groups: [{ files: ["src/shipping.js"], rule: "Check the threshold." }],
      note: null,
    });
    expect(existsSync(fake)).toBe(true);
  });
});
