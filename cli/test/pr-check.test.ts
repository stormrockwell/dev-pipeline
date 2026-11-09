import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const tmpDir = join("/tmp", "pr-check-test");
const bin = join(__dirname, "..", "bin", "pipeline");

function cleanup() {
  rmSync(tmpDir, { recursive: true, force: true });
}

function pipeline(...args: string[]) {
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: 20_000 });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function writeTestFile(name: string, content: string) {
  mkdirSync(tmpDir, { recursive: true });
  const path = join(tmpDir, name);
  writeFileSync(path, content);
  return path;
}

describe("pr-check", () => {
  describe("good PR body", () => {
    it("passes a complete valid PR body", () => {
      const body = `## What changed
- Added CSV export feature
- New export button on Orders page
- Endpoint accepts format param

## Why this approach
We use a CSV format because it is widely supported. The export runs on demand to avoid storage overhead.

## How to verify
Visit /orders, click Export, choose CSV format. Check the file contains all columns and rows.

## Risk
Door: two-way. Blast radius: Orders page, download endpoint.

## Auditors
- Ran: security (quick), standards, spec
- Skipped: design (no Figma frame linked), performance (data under scale threshold)
`;
      const file = writeTestFile("good.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      cleanup();
    });
  });

  describe("sections check", () => {
    it("fails when missing required section", () => {
      const body = `## What changed
- Added export feature

## Why this approach
We chose this approach for simplicity.

## Risk
Door: one-way. Blast radius: Orders page.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("missing-verify.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("sections");
      cleanup();
    });

    it("fails when sections are out of order", () => {
      const body = `## Why this approach
We chose this approach for simplicity.

## What changed
- Added export feature

## How to verify
Click the button.

## Risk
Door: one-way. Blast radius: Orders.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("out-of-order.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("sections");
      cleanup();
    });

    it("passes when Human review required is before Auditors", () => {
      const body = `## What changed
- Added feature

## Why this approach
Simple approach.

## How to verify
Test it.

## Risk
Door: one-way. Blast radius: local.

## Human review required
See /auth/login.php lines 50-60 for the permission check.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("human-review.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(0);
      cleanup();
    });
  });

  describe("length check", () => {
    it("fails when body exceeds 250 words (excluding Auditors section)", () => {
      const longBody = "word ".repeat(251);
      const body = `## What changed
${longBody}

## Why this approach
Approach here.

## How to verify
Test it.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("too-long.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("length");
      cleanup();
    });

    it("passes with exactly 250 words", () => {
      const longBody = "word ".repeat(240) + "more";
      const body = `## What changed
${longBody}

## Why this approach
Approach here.

## How to verify
Test it.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("exact-250.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(0);
      cleanup();
    });

    it("excludes Auditors section from word count", () => {
      const longBody = "word ".repeat(240);
      const body = `## What changed
${longBody}done

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: ${" ".repeat(500)}
`;
      const file = writeTestFile("auditors-excluded.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(0);
      cleanup();
    });

    it("excludes <details> blocks from word count", () => {
      const body = `## What changed
- Added feature

## Why this approach
Approach here.

## How to verify
Test it.

## Risk
Door: one-way. Blast radius: local.

<details>
<summary>Details</summary>
${"word ".repeat(500)}
</details>

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("details-excluded.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(0);
      cleanup();
    });

    it("excludes Co-Authored using AI line from word count", () => {
      const longBody = "word ".repeat(240);
      const body = `## What changed
${longBody}done

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)

Co-Authored using AI
`;
      const file = writeTestFile("coauth-excluded.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(0);
      cleanup();
    });
  });

  describe("what-changed check", () => {
    it("fails with more than five bullets in What changed", () => {
      const body = `## What changed
- First
- Second
- Third
- Fourth
- Fifth
- Sixth

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("too-many-bullets.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("what-changed");
      cleanup();
    });

    it("passes with exactly five bullets", () => {
      const body = `## What changed
- First
- Second
- Third
- Fourth
- Fifth

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("five-bullets.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(0);
      cleanup();
    });
  });

  describe("why check", () => {
    it("fails with more than three sentences in Why", () => {
      const body = `## What changed
- Added feature

## Why this approach
First sentence. Second sentence. Third sentence. Fourth sentence.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("too-many-sentences.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("why");
      cleanup();
    });

    it("passes with exactly three sentences", () => {
      const body = `## What changed
- Added feature

## Why this approach
First sentence. Second sentence. Third sentence.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("three-sentences.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(0);
      cleanup();
    });

    it("does not count periods inside versions, file names or paths", () => {
      const body = `## What changed
- Added feature

## Why this approach
Plugins require PHP 8.0 and read docs/STRATEGY.md first. The config lives in .github/workflows/ci.yml today. Third sentence.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("periods-in-words.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(0);
      cleanup();
    });
  });

  describe("risk check", () => {
    it("fails without Door line", () => {
      const body = `## What changed
- Added feature

## Why this approach
Approach.

## How to verify
Test.

## Risk
Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("no-door.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("risk");
      cleanup();
    });

    it("fails without Blast radius line", () => {
      const body = `## What changed
- Added feature

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: one-way.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("no-blast.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("risk");
      cleanup();
    });

    it("fails with bad Door value", () => {
      const body = `## What changed
- Added feature

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: both-ways. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("bad-door.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("risk");
      cleanup();
    });

    it("passes with one-way Door", () => {
      const body = `## What changed
- Added feature

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("one-way.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(0);
      cleanup();
    });

    it("passes with two-way Door", () => {
      const body = `## What changed
- Added feature

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: two-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("two-way.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(0);
      cleanup();
    });
  });

  describe("auditors check", () => {
    it("fails without Ran or Skipped line", () => {
      const body = `## What changed
- Added feature

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Accepted: fix already applied
`;
      const file = writeTestFile("no-ran.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("auditors");
      cleanup();
    });

    it("fails when skipped item has no reason", () => {
      const body = `## What changed
- Added feature

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
- Skipped: design
`;
      const file = writeTestFile("skipped-no-reason.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("auditors");
      cleanup();
    });

    it("passes when all skipped items have reasons", () => {
      const body = `## What changed
- Added feature

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
- Skipped: design (no Figma frame), performance (data under scale)
`;
      const file = writeTestFile("skipped-with-reason.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(0);
      cleanup();
    });

    it("fails when Accepted item has no reason", () => {
      const body = `## What changed
- Added feature

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
- Accepted: design
`;
      const file = writeTestFile("accepted-no-reason.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("auditors");
      cleanup();
    });

    it("passes when all Accepted items have reasons", () => {
      const body = `## What changed
- Added feature

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
- Accepted: design (visual consistency ok), performance (paginated query)
`;
      const file = writeTestFile("accepted-with-reason.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(0);
      cleanup();
    });
  });

  describe("narration check", () => {
    it("fails with 'I first tried' narration", () => {
      const body = `## What changed
- Added feature

## Why this approach
I first tried a different approach but it was too complex. We settled on this one.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("narration-first-tried.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("narration");
      cleanup();
    });

    it("fails with 'initially' narration", () => {
      const body = `## What changed
- Added feature

## Why this approach
Initially we had a problem with this approach. Then we fixed it.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("narration-initially.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("narration");
      cleanup();
    });

    it("fails with 'after trying' narration", () => {
      const body = `## What changed
- Added feature

## Why this approach
After trying several approaches, we chose this one.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("narration-after-trying.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("narration");
      cleanup();
    });

    it("fails with 'we decided to change' narration", () => {
      const body = `## What changed
- Added feature

## Why this approach
We decided to change the approach because it makes the code simpler.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("narration-decided.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("narration");
      cleanup();
    });
  });

  describe("title check", () => {
    it("passes with conventional commit title type(scope)", () => {
      const body = `## What changed
- Added feature

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("title-test.md", body);
      const result = pipeline("pr-check", "--file", file, "--title", "feat(orders): add CSV export");
      expect(result.status).toBe(0);
      cleanup();
    });

    it("passes with conventional commit title type", () => {
      const body = `## What changed
- Added feature

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("title-test2.md", body);
      const result = pipeline("pr-check", "--file", file, "--title", "docs: update README");
      expect(result.status).toBe(0);
      cleanup();
    });

    it("fails with non-conventional title", () => {
      const body = `## What changed
- Added feature

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("title-bad.md", body);
      const result = pipeline("pr-check", "--file", file, "--title", "Add CSV export feature");
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("title");
      cleanup();
    });
  });

  describe("input options", () => {
    it("accepts --file option", () => {
      const body = `## What changed
- Added feature

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("file-test.md", body);
      const result = pipeline("pr-check", "--file", file);
      expect(result.status).toBe(0);
      cleanup();
    });

    it("requires either --file or --pr", () => {
      const result = pipeline("pr-check");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--file or --pr");
      cleanup();
    });
  });

  describe("--json output", () => {
    it("outputs JSON when --json flag is set", () => {
      const body = `## What changed
- Added feature

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("json-test.md", body);
      const result = pipeline("pr-check", "--file", file, "--json");
      expect(result.status).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json).toHaveProperty("results");
      cleanup();
    });

    it("JSON contains all check results", () => {
      const body = `## What changed
- First
- Second
- Third
- Fourth
- Fifth
- Sixth

## Why this approach
Approach.

## How to verify
Test.

## Risk
Door: one-way. Blast radius: local.

## Auditors
- Ran: security (quick)
`;
      const file = writeTestFile("json-fail.md", body);
      const result = pipeline("pr-check", "--file", file, "--json");
      expect(result.status).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json).toHaveProperty("results");
      expect(Array.isArray(json.results)).toBe(true);
      cleanup();
    });
  });
});
