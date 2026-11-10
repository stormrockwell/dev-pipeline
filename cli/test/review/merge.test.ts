import { describe, expect, it } from "vitest";
import { type Finding, overlaps, replyJson, type ReportedFinding, type Reviewer, sameProblem, validateFindings } from "../../src/review/findings.ts";
import { mergeRound, NIT_CAP } from "../../src/review/merge.ts";
import { parseHunks } from "../../src/review/route.ts";

const finding = (overrides: Partial<ReportedFinding> = {}): ReportedFinding => ({
  axis: "correctness",
  tag: "Important",
  file: "src/a.js",
  line: 10,
  title: "Orders at the threshold do not ship free",
  detail: "The comparison is strict.",
  ...overrides,
});

const merge = (reports: [Reviewer, ReportedFinding[]][], extra: Partial<Parameters<typeof mergeRound>[0]> = {}) =>
  mergeRound({ round: 1, scope: "full", head: "abc", reports: new Map(reports), open: [], removed: [], fixLines: null, ...extra });

describe("validateFindings", () => {
  it("accepts an empty list and a well-formed finding", () => {
    expect(validateFindings("spec", { findings: [] }, [])).toEqual({ findings: [], problems: [] });
    expect(validateFindings("spec", { findings: [finding()] }, []).problems).toEqual([]);
  });

  it("keeps each reviewer to its own axes, so none can outrank the reviewer that owns an axis", () => {
    expect(validateFindings("simplifier", { findings: [finding({ axis: "correctness" })] }, []).problems[0]).toContain("simplifier reports readability");
    expect(validateFindings("standards", { findings: [finding({ axis: "security" })] }, []).problems).toHaveLength(1);
  });

  it("names every problem, and takes an id only for one of the reviewer's open findings", () => {
    const { problems } = validateFindings("spec", { findings: [{ axis: "correctness", tag: "Big", file: "", title: "", detail: "x", id: "spec-1.9", line: 0 }] }, ["spec-1.1"]);
    expect(problems.join("\n")).toMatch(/tag "Big"[\s\S]*"file"[\s\S]*"line"[\s\S]*"title"[\s\S]*spec-1\.9/);
    expect(validateFindings("spec", { findings: [finding({ id: "spec-1.1" })] }, ["spec-1.1"]).problems).toEqual([]);
    expect(validateFindings("spec", [], []).problems[0]).toContain('"findings" array');
  });
});

describe("replyJson", () => {
  it("reads the last json block of a reply", () => {
    expect(replyJson('Draft:\n```json\n{"findings": [1]}\n```\nFinal:\n```json\n{"findings": []}\n```\nPackage: /p')).toEqual({ value: { findings: [] } });
    expect(replyJson("no block")).toEqual({ error: expect.stringContaining("no ```json block") });
    expect(replyJson("```json\n{nope\n```")).toEqual({ error: expect.stringContaining("not valid JSON") });
  });
});

describe("overlaps and sameProblem", () => {
  it("treats a finding with no line as covering the whole file", () => {
    expect(overlaps(finding({ line: 10, end_line: 14 }), finding({ line: 14 }))).toBe(true);
    expect(overlaps(finding({ line: 10 }), finding({ line: 12 }))).toBe(false);
    expect(overlaps(finding({ line: undefined }), finding({ line: 99 }))).toBe(true);
    expect(overlaps(finding(), finding({ file: "src/b.js" }))).toBe(false);
  });

  it("matches titles that share most of their words", () => {
    expect(sameProblem("Strict comparison misses the threshold", "The threshold comparison is strict")).toBe(true);
    expect(sameProblem("Strict comparison misses the threshold", "Rename the helper")).toBe(false);
  });
});

describe("mergeRound", () => {
  it("assigns ids and orders the fix list by precedence", () => {
    const { accepted, opened } = merge([
      ["standards", [finding({ axis: "style", tag: "Nit", title: "Use const", line: 30 })]],
      ["spec", [finding()]],
      ["simplifier", [finding({ axis: "readability", title: "Inline the helper", line: 50 })]],
    ]);
    expect(accepted.map((entry) => [entry.id, entry.axis])).toEqual([
      ["spec-1.1", "correctness"],
      ["simplifier-1.1", "readability"],
      ["standards-1.1", "style"],
    ]);
    expect(opened).toBe(3);
  });

  it("keeps the higher finding of two that name the same problem on the same lines", () => {
    const { accepted, duplicates } = merge([
      ["standards", [finding({ axis: "correctness", tag: "Nit", title: "Threshold comparison is strict" })]],
      ["spec", [finding({ title: "Strict threshold comparison" })]],
    ]);
    expect(accepted.map((entry) => entry.id)).toEqual(["spec-1.1"]);
    expect(duplicates).toEqual([{ dropped: "standards-1.1", kept: "spec-1.1" }]);
    expect(accepted[0]!.instances).toEqual([{ file: "src/a.js", line: 10 }]);
  });

  it("lists findings from different axes on the same lines as a contest, higher first", () => {
    const { contests } = merge([
      ["simplifier", [finding({ axis: "readability", title: "Drop the branch, it never runs", line: 11 })]],
      ["spec", [finding({ title: "Add the missing branch for wholesale", line: 10, end_line: 12 })]],
    ]);
    expect(contests).toEqual([{ high: "spec-1.1", low: "simplifier-1.1" }]);
  });

  it("sends pre-existing problems and nits past the cap to the backlog", () => {
    const nits = Array.from({ length: NIT_CAP + 2 }, (_, index) => finding({ axis: "style", tag: "Nit", title: `Nit number ${index}`, line: 100 + index * 10 }));
    const { accepted, backlog } = merge([["standards", [...nits, finding({ axis: "style", tag: "Pre-existing", title: "Old code", line: 500 })]]]);
    expect(accepted).toHaveLength(NIT_CAP);
    expect(backlog.map((entry) => entry.why)).toEqual(["pre-existing", "over the nit cap", "over the nit cap"]);
  });

  it("counts an open finding its reviewer left out as fixed, and keeps one it re-reported", () => {
    const open: Finding[] = [
      { ...finding(), id: "spec-1.1", reviewer: "spec" },
      { ...finding({ line: 40, title: "Another" }), id: "spec-1.2", reviewer: "spec" },
    ];
    const { accepted, fixed, opened } = merge([["spec", [finding({ id: "spec-1.2", line: 40, title: "Another" })]]], { round: 2, scope: "fix", open, fixLines: { "src/a.js": [40] } });
    expect(fixed).toEqual(["spec-1.1"]);
    expect(accepted.map((entry) => entry.id)).toEqual(["spec-1.2"]);
    expect(opened).toBe(0);
  });

  it("sends a new finding off the fix diff to the backlog in a fix round", () => {
    const { accepted, backlog } = merge(
      [
        [
          "standards",
          [
            finding({ axis: "style", title: "On the fix", line: 41 }),
            finding({ axis: "style", title: "Far away", line: 200 }),
          ],
        ],
      ],
      { round: 2, scope: "fix", fixLines: { "src/a.js": [40] } },
    );
    expect(accepted.map((entry) => entry.title)).toEqual(["On the fix"]);
    expect(backlog).toEqual([expect.objectContaining({ title: "Far away", why: "outside the fix diff" })]);
  });

  it("leaves out findings an overrule or dismissal took off", () => {
    const { accepted } = merge([["spec", [finding()]]], { removed: ["spec-1.1"] });
    expect(accepted).toEqual([]);
  });
});

describe("parseHunks", () => {
  it("keeps the old line a hunk replaced and the new lines it wrote", () => {
    const diff = ["diff --git a/src/a.js b/src/a.js", "--- a/src/a.js", "+++ b/src/a.js", "@@ -3 +3,2 @@", "-old", "+new", "+more", "@@ -9,0 +11 @@", "+added"].join("\n");
    expect(parseHunks(diff)).toEqual([
      { file: "src/a.js", oldStart: 3, oldCount: 1, added: [{ line: 3, text: "new" }, { line: 4, text: "more" }], removed: ["old"] },
      { file: "src/a.js", oldStart: 9, oldCount: 0, added: [{ line: 11, text: "added" }], removed: [] },
    ]);
  });
});
