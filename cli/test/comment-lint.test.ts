import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "pipeline");

function pipeline(cwd?: string, ...args: string[]) {
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: 20_000, cwd });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function createTempRepo() {
  const tmpdir = mkdtempSync(join("/tmp", "comment-lint-test-"));
  execSync("git init", { cwd: tmpdir });
  execSync("git config user.email 'test@example.com'", { cwd: tmpdir });
  execSync("git config user.name 'Test User'", { cwd: tmpdir });
  return tmpdir;
}

function createFile(dir: string, path: string, content: string) {
  const fullPath = join(dir, path);
  const fileDir = dirname(fullPath);
  execSync(`mkdir -p "${fileDir}"`, { cwd: dir });
  writeFileSync(fullPath, content);
}

function stageFile(dir: string, path: string) {
  execSync(`git add "${path}"`, { cwd: dir });
}

function commitFile(dir: string, path: string, content: string, message: string) {
  createFile(dir, path, content);
  stageFile(dir, path);
  execSync(`git commit -m "${message}"`, { cwd: dir });
}

describe("comment-lint", () => {
  let tmpdir: string;

  afterEach(() => {
    rmSync(tmpdir, { recursive: true, force: true });
  });

  describe("basic functionality", () => {
    it("exits 0 by default when no issues found", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "// This is a regular comment\nconst x = 1;", "initial");
      createFile(tmpdir, "test.js", "// This is a regular comment\n// Another good comment\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.status).toBe(0);
    });

    it("exits 0 even with flags when no issues found", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "// Regular comment\nconst x = 1;", "initial");
      createFile(tmpdir, "test.js", "// Regular comment\n// Good description\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged", "--fail");
      expect(result.status).toBe(0);
    });

    it("exits 1 with --fail when issues found", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// TODO: fix this\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged", "--fail");
      expect(result.status).toBe(1);
    });
  });

  describe("temporal rule", () => {
    it("flags 'now' in comments", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// Changed now to handle this\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("temporal");
      expect(result.stdout).toContain("Changed now");
    });

    it("flags 'previously' in comments", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// Previously we did it this way\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("temporal");
    });

    it("flags 'changed' in comments", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// changed to use new API\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("temporal");
    });
  });

  describe("reviewer rule", () => {
    it("flags 'note to reviewer' in comments", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// note to reviewer: check this carefully\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("reviewer");
    });

    it("flags 'safe:' in comments", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// safe: this won't break anything\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("reviewer");
    });

    it("flags 'as discussed' in comments", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// as discussed in standup\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("reviewer");
    });
  });

  describe("todo-no-issue rule", () => {
    it("flags TODO without issue reference", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// TODO: fix this later\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("todo-no-issue");
    });

    it("flags FIXME without issue reference", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// FIXME: this is broken\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("todo-no-issue");
    });

    it("allows TODO with issue number", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// TODO #123: fix this later\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).not.toContain("todo-no-issue");
    });

    it("allows TODO with URL", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// TODO: https://example.com/issues/123\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).not.toContain("todo-no-issue");
    });
  });

  describe("commented-code rule", () => {
    it("flags comment ending with semicolon", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// const y = 2;\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("commented-code");
    });

    it("flags comment ending with brace", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// if (true) {\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("commented-code");
    });

    it("flags comment containing arrow function", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// const fn = () => { }\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("commented-code");
    });

    it("flags comment containing 'function('", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// function(x) { return x; }\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("commented-code");
    });

    it("flags comment containing variable assignment with $", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.php", "<?php", "initial");
      createFile(tmpdir, "test.php", "<?php\n// $var = 123;\n");
      stageFile(tmpdir, "test.php");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("commented-code");
    });
  });

  describe("dash rule", () => {
    it("flags em dash in comment", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// This is an em dash — here\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("dash");
    });

    it("flags en dash in comment", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// This is an en dash – here\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("dash");
    });
  });

  describe("restates rule", () => {
    it("flags comment that mostly restates next line identifiers", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// initialize user data\nconst userData = initializeUserData();");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("restates");
    });
  });

  describe("multiple file types", () => {
    it("handles JavaScript files", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// TODO: fix\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("test.js");
    });

    it("handles TypeScript files", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.ts", "const x = 1;", "initial");
      createFile(tmpdir, "test.ts", "// TODO: fix\nconst x = 1;");
      stageFile(tmpdir, "test.ts");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("test.ts");
    });

    it("handles CSS files with /* */ comments", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.css", "body {}", "initial");
      createFile(tmpdir, "test.css", "/* TODO: add styles */\nbody {}");
      stageFile(tmpdir, "test.css");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("test.css");
    });

    it("handles HTML files with <!-- --> comments", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.html", "<p>test</p>", "initial");
      createFile(tmpdir, "test.html", "<!-- TODO: fix -->\n<p>test</p>");
      stageFile(tmpdir, "test.html");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("test.html");
    });

    it("handles PHP files with # comments", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.php", "<?php", "initial");
      createFile(tmpdir, "test.php", "<?php\n# TODO: fix\necho 'test';");
      stageFile(tmpdir, "test.php");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toContain("test.php");
    });
  });

  describe("JSON output", () => {
    it("outputs JSON with --json flag", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// TODO: fix\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged", "--json");
      const json = JSON.parse(result.stdout);
      expect(Array.isArray(json)).toBe(true);
      expect(json[0]).toHaveProperty("file");
      expect(json[0]).toHaveProperty("line");
      expect(json[0]).toHaveProperty("rule");
      expect(json[0]).toHaveProperty("text");
    });
  });

  describe("output format", () => {
    it("prints file:line  rule  comment text format", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// TODO: fix\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).toMatch(/test\.js:\d+\s+todo-no-issue\s+/);
    });
  });

  describe("clean controls", () => {
    it("ignores @param docblock lines", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "function f() {}", "initial");
      createFile(tmpdir, "test.js", "/**\n * @param {string} name - The name\n */\nfunction f() {}");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).not.toContain("docblock");
      expect(result.status).toBe(0);
    });

    it("ignores TODO with issue reference", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// TODO #123: fix this\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).not.toContain("todo-no-issue");
    });

    it("allows hyphen in URLs", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// See https://example.com/foo-bar for details\nconst x = 1;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.stdout).not.toContain("dash");
    });

    it("allows regular explanatory comments", () => {
      tmpdir = createTempRepo();
      commitFile(tmpdir, "test.js", "const x = 1;", "initial");
      createFile(tmpdir, "test.js", "// Check if the value is positive\nconst isPositive = x > 0;");
      stageFile(tmpdir, "test.js");

      const result = pipeline(tmpdir, "comment-lint", "--staged");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    });
  });
});
