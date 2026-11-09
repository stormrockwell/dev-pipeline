import { afterAll, describe, expect, it } from "vitest";
import { builtinConfig, parseConfig } from "../../src/commands/scan-zones/config.ts";
import { scanFile } from "../../src/commands/scan-zones/scan.ts";
import type { FileInput, Zone } from "../../src/commands/scan-zones/types.ts";
import { commit, makeRepo, pipeline, removeTemps, stage } from "../helpers/repo.ts";

afterAll(removeTemps);

const config = builtinConfig();

// A diff of one file, where `content` is the new file and `added` are 1-based new line numbers.
function edit(path: string, content: string, added: number[], removed: string[] = []): FileInput {
  return {
    path,
    content,
    added: new Set(added),
    removed: removed.map((text, index) => ({ line: index + 1, text })),
    deleted: false,
  };
}

function zones(input: FileInput, using = config): Zone[] {
  return scanFile(using, input).zones;
}

const sql = "migrations/0002_hosts.sql";

describe("comment-only edits to a migration", () => {
  it("is not a path hit when every added line is a SQL comment", () => {
    const content = "-- Hostnames are stored lowercase.\n-- The unique index relies on it.\n\nCREATE UNIQUE INDEX idx ON hosts (name);\n";
    expect(zones(edit(sql, content, [1, 2]))).toEqual([]);
  });

  it("accepts blank lines and hash comments beside SQL comments", () => {
    const content = "# note\n\n-- more\nCREATE TABLE t (id INT);\n";
    expect(zones(edit(sql, content, [1, 2, 3]))).toEqual([]);
  });

  it("accepts a block comment added whole", () => {
    const content = "/*\n * Why this index exists.\n */\nCREATE INDEX i ON t (a);\n";
    expect(zones(edit(sql, content, [1, 2, 3]))).toEqual([]);
  });

  it("accepts a reworded comment, with the old comment line removed", () => {
    const content = "-- New wording.\nCREATE INDEX i ON t (a);\n";
    expect(zones(edit(sql, content, [1], ["-- Old wording."]))).toEqual([]);
  });

  it("accepts an edit inside an existing block comment", () => {
    const content = "/*\n * Changed text.\n */\nCREATE INDEX i ON t (a);\n";
    expect(zones(edit(sql, content, [2], [" * Old text."]))).toEqual([]);
  });

  it("stays a path hit when a code line changes beside the comment", () => {
    const content = "-- note\nALTER TABLE hosts ADD COLUMN x INT;\n";
    expect(zones(edit(sql, content, [1, 2]))).toEqual(["data-loss"]);
  });

  it("stays a path hit when a removed line is code, even if an added line comments it out", () => {
    const content = "-- DROP TABLE old;\n";
    expect(zones(edit(sql, content, [1], ["DROP TABLE old;"]))).toEqual(["data-loss"]);
  });

  it("stays a path hit for a MySQL conditional comment, because it executes", () => {
    const content = "/*!40101 SET NAMES utf8mb4 */;\n";
    expect(zones(edit(sql, content, [1]))).toEqual(["data-loss"]);
    const block = "/*!50003\nDROP TABLE t;\n*/;\n";
    expect(zones(edit(sql, block, [1, 2, 3]))).toEqual(["data-loss"]);
  });

  it("stays a path hit for an optimizer hint comment", () => {
    expect(zones(edit(sql, "SELECT /*+ NO_INDEX(t) */ 1;\n", [1]))).toEqual(["data-loss"]);
  });

  it("stays a path hit when added comment lines wrap existing code", () => {
    const content = "/*\nDROP TABLE users;\n*/\n";
    expect(zones(edit(sql, content, [1, 3]))).toEqual(["data-loss"]);
  });

  it("stays a path hit when removed lines uncomment existing code", () => {
    const content = "DROP TABLE users;\n";
    expect(zones(edit(sql, content, [], ["/*", "*/"]))).toEqual(["data-loss"]);
  });

  it("stays a path hit when a code line follows a comment on the same line", () => {
    expect(zones(edit(sql, "/* gone */ DROP TABLE t;\n", [1]))).toEqual(["data-loss"]);
    expect(zones(edit(sql, "DROP TABLE t; -- gone\n", [1]))).toEqual(["data-loss"]);
  });

  it("does not take a comment marker inside a string for a comment", () => {
    expect(zones(edit(sql, "INSERT INTO t VALUES ('-- x',\n'/*');\n", [1, 2]))).toEqual(["data-loss"]);
    expect(zones(edit(sql, "INSERT INTO t VALUES ('a\n-- not a comment',\n'b');\n", [2]))).toEqual(["data-loss"]);
  });

  it("stays a path hit when the double dash is not followed by a space", () => {
    expect(zones(edit(sql, "--1;\n", [1]))).toEqual(["data-loss"]);
  });

  it("stays a path hit for a new file, because the migration itself is the change", () => {
    expect(zones(edit(sql, "-- empty for now\n", [1]))).toEqual(["data-loss"]);
  });

  it("stays a path hit when nothing in the diff says what changed", () => {
    expect(zones(edit(sql, "-- x\nSELECT 1;\n", []))).toEqual(["data-loss"]);
  });

  it("stays a path hit in a tree scan, which has no changed lines", () => {
    const input: FileInput = { path: sql, content: "-- x\n", added: null, removed: [], deleted: false };
    expect(zones(input)).toEqual(["data-loss"]);
  });

  it("stays a path hit for a deleted migration", () => {
    const input: FileInput = { path: sql, content: null, added: new Set(), removed: [{ line: 1, text: "-- x" }], deleted: true };
    expect(zones(input)).toEqual(["data-loss"]);
  });

  it("stays a path hit for a file type with no comment rules", () => {
    expect(zones(edit("migrations/0002.json", "# note\n{}\n", [1]))).toEqual(["data-loss"]);
  });
});

describe("comment-only edits in other languages", () => {
  it("accepts PHP comments", () => {
    const content = "<?php\n// Why this runs.\n# Also this.\n/**\n * Docblock.\n */\nfunction up() {}\n";
    expect(zones(edit("migrations/001_up.php", content, [2, 3, 4, 5, 6]))).toEqual([]);
  });

  it("does not take a PHP attribute for a comment", () => {
    const content = "<?php\n#[Migration]\nfunction up() {}\n";
    expect(zones(edit("migrations/001_up.php", content, [2]))).toEqual(["data-loss"]);
  });

  it("accepts JavaScript comments", () => {
    const content = "// Why this runs.\nexports.up = (k) => k.schema.dropTable('x');\n";
    expect(zones(edit("db/migrations/001.js", content, [1]))).toEqual([]);
  });

  it("does not take a hash line in JavaScript for a comment", () => {
    expect(zones(edit("db/migrations/001.js", "# nope\nexports.up = 1;\n", [1]))).toEqual(["data-loss"]);
  });
});

describe("what the exemption never reaches", () => {
  it("applies to a data-loss rule from a sensitive.yml too", () => {
    const own = parseConfig("paths:\n  - path: 'db/schema/**'\n    zone: data-loss\n");
    expect(zones(edit("db/schema/users.sql", "-- note\nCREATE TABLE u (id INT);\n", [1]), own)).toEqual([]);
  });

  it("never applies to a guardrails path", () => {
    expect(zones(edit(".github/workflows/ci.yml", "# nosemgrep\nname: ci\n", [1]))).toEqual(["guardrails"]);
    expect(zones(edit(".github/CODEOWNERS", "# owner change\n", [1], ["* @old"]))).toEqual(["guardrails"]);
    const own = parseConfig("paths:\n  - 'db/migrations/**'\n");
    expect(zones(edit("db/migrations/1.sql", "-- note\nSELECT 1;\n", [1]), own)).toEqual(["guardrails"]);
  });

  it("keeps a guardrails hit when the same file also has a data-loss rule", () => {
    const own = parseConfig("paths:\n  - 'db/migrations/**'\n  - path: 'db/migrations/**'\n    zone: data-loss\n");
    expect(zones(edit("db/migrations/1.sql", "-- note\nSELECT 1;\n", [1]), own)).toEqual(["guardrails"]);
  });

  it("still lets content signals fire on the comment text", () => {
    const scan = scanFile(config, edit(sql, "-- DROP TABLE t was removed\nSELECT 1;\n", [1]));
    expect(scan.zones).toEqual(["data-loss"]);
    expect(scan.matches.every((match) => match.kind === "signal")).toBe(true);
  });
});

describe("in a real range", () => {
  function zonesBetween(repo: string, from: string, to: string): string[] {
    const result = pipeline(repo, ["scan-zones", "--range", `${from}..${to}`, "--json"]);
    expect(result.status).toBe(0);
    return (JSON.parse(result.stdout) as { files: { zones: string[] }[] }).files.flatMap((file) => file.zones);
  }

  it("drops the path hit for a comment added to a committed migration and keeps it for a code edit", () => {
    const repo = makeRepo();
    stage(repo, "migrations/0002.sql", "CREATE TABLE t (id INT);\n");
    const base = commit(repo, "feat: migration");
    stage(repo, "migrations/0002.sql", "-- Added for clarity.\nCREATE TABLE t (id INT);\n");
    const commented = commit(repo, "docs: comment");
    stage(repo, "migrations/0002.sql", "-- Added for clarity.\nCREATE TABLE t (id INT, name TEXT);\n");
    const edited = commit(repo, "feat: column");
    expect(zonesBetween(repo, base, commented)).toEqual([]);
    expect(zonesBetween(repo, commented, edited)).toEqual(["data-loss"]);
    expect(zonesBetween(repo, base, edited)).toEqual(["data-loss"]);
  });
});
