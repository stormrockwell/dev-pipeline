import { describe, expect, it } from "vitest";
import { classifyInputs } from "../../src/commands/classify/tier.ts";
import { builtinConfig, DEFAULT_TEST_PATHS, parseConfig } from "../../src/commands/scan-zones/config.ts";
import { scanFile, scanText } from "../../src/commands/scan-zones/scan.ts";
import type { FileInput, Zone } from "../../src/commands/scan-zones/types.ts";

const config = builtinConfig();

function zonesOf(path: string, content: string, using = config): Zone[] {
  return scanText(using, path, content).zones;
}

const signalLine = "const out = eval(code);\n";

describe("default test paths", () => {
  it("lists the six patterns from the baseline report", () => {
    expect(DEFAULT_TEST_PATHS).toEqual(["**/test/**", "**/tests/**", "**/__tests__/**", "*.test.*", "*.spec.*", "*Test.php"]);
  });

  it.each([
    "test/a.js",
    "cli/test/zones/a.ts",
    "tests/Integration/a.php",
    "src/__tests__/a.js",
    "src/widget.test.ts",
    "src/widget.spec.js",
    "includes/FooTest.php",
  ])("skips content signals in %s", (path) => {
    expect(zonesOf(path, path.endsWith(".php") ? "<?php eval($code);\n" : signalLine)).toEqual([]);
  });

  it.each(["src/latest.php", "src/contest.js", "src/testing/a.js", "src/attest.test-utils.js", "src/protests/a.js"])(
    "still scans %s, which only resembles a test path",
    (path) => {
      const content = path.endsWith(".php") ? "<?php eval($code);\n" : signalLine;
      expect(zonesOf(path, content)).toEqual(["input"]);
    },
  );

  it("matches the names case sensitively, so latest.php is not a test", () => {
    expect(zonesOf("src/latest.php", "<?php eval($code);\n")).toEqual(["input"]);
    expect(zonesOf("src/LatestTest.php", "<?php eval($code);\n")).toEqual([]);
  });
});

describe("what a test file keeps", () => {
  it("still applies path rules", () => {
    const scan = scanText(config, "tests/auth/login.test.js", signalLine);
    expect(scan.zones).toEqual(["auth"]);
    expect(scan.matches.map((match) => match.kind)).toEqual(["path"]);
  });

  it("keeps a manifest or workflow under a test directory in guardrails", () => {
    expect(zonesOf("tests/fixtures/package.json", "{}\n")).toEqual(["guardrails"]);
    expect(zonesOf(".github/tests/run.test.yml", "x\n")).toEqual(["guardrails"]);
  });

  it("keeps the secrets zone", () => {
    // Built in two pieces so this file does not trip the secrets zone it is testing.
    const secretLine = `const secret = process.env.${"SESSION"}_SECRET;\n`;
    const scan = scanText(config, "src/session.test.js", `${signalLine}${secretLine}`);
    expect(scan.zones).toEqual(["secrets"]);
    expect(scan.matches).toHaveLength(1);
    expect(scan.matches[0]!.line).toBe(2);
  });

  it("keeps the secrets zone for the WordPress salts", () => {
    expect(zonesOf("tests/bootstrap.php", "<?php define( 'AUTH_KEY', 'x' );\n")).toEqual(["secrets"]);
  });

  it("does not report removed lines that matched a content signal", () => {
    const input: FileInput = {
      path: "tests/PermissionTest.php",
      content: "<?php\n",
      added: new Set(),
      removed: [{ line: 3, text: "if ( current_user_can( 'edit_posts' ) ) {" }],
      deleted: false,
    };
    expect(scanFile(config, input).removed).toEqual([]);
  });

  it("does not let a mention of request data in a test string arm the write heuristic", () => {
    const content = "<?php\nupdate_option( 'a', 1 );\n$_POST['a'] = 1;\n";
    expect(zonesOf("tests/OptionTest.php", content)).toEqual([]);
    expect(zonesOf("src/Option.php", content)).toEqual(["input"]);
  });

  it("classifies a test file with a dangerous call as T2, not T3", () => {
    const input: FileInput = { path: "src/run.test.js", content: signalLine, added: null, removed: [], deleted: false };
    expect(classifyInputs(config, [input]).tier).toBe("T2");
  });
});

describe("test_paths in sensitive.yml", () => {
  it("defaults to the built-in list when the key is omitted", () => {
    expect(parseConfig("paths:\n  - 'a/**'\n").testPaths).toEqual(DEFAULT_TEST_PATHS);
    expect(builtinConfig().testPaths).toEqual(DEFAULT_TEST_PATHS);
  });

  it("replaces the list, so a repo with a shipped tests directory can opt out", () => {
    const own = parseConfig("packs: [node]\ntest_paths:\n  - '**/*.test.*'\n");
    expect(own.testPaths).toEqual(["**/*.test.*"]);
    expect(zonesOf("tests/helper.js", signalLine, own)).toEqual(["input"]);
    expect(zonesOf("src/a.test.js", signalLine, own)).toEqual([]);
  });

  it("lets a repo add its own directory by listing it beside the defaults", () => {
    const own = parseConfig(`packs: [node]\ntest_paths:\n  - '**/test/**'\n  - '**/e2e/**'\n`);
    expect(zonesOf("e2e/run.js", signalLine, own)).toEqual([]);
    expect(zonesOf("tests/run.js", signalLine, own)).toEqual(["input"]);
  });

  it("allows an empty list to scan every file", () => {
    const own = parseConfig("packs: [node]\ntest_paths:\n");
    expect(own.testPaths).toEqual([]);
    expect(zonesOf("tests/run.test.js", signalLine, own)).toEqual(["input"]);
  });

  it("rejects a value that is not a list of globs", () => {
    expect(() => parseConfig("test_paths: yes\n")).toThrow(/test_paths: must be a list/);
    expect(() => parseConfig("test_paths:\n  - 'a/{b'\n")).toThrow(/test_paths\[0\]/);
    expect(() => parseConfig("test_paths:\n  - ''\n")).toThrow(/test_paths\[0\]/);
  });
});
