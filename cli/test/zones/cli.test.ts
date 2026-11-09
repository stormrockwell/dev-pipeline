import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { commit, git, makeRepo, pipeline, removeTemps, stage, tempDir, write } from "../helpers/repo.ts";

afterAll(removeTemps);

interface JsonReport {
  mode: string;
  config: { source: string; packs: string[] };
  summary: { filesScanned: number; matches: number; removed: number; zones: Record<string, number> };
  removed: { file: string; line: number; zone: string; text: string }[];
  files: { file: string; zones: string[]; matchCount: number; matches: { line: number | null; zone: string }[] }[];
}

function scan(cwd: string, args: string[] = []) {
  const result = pipeline(cwd, ["scan-zones", ...args, "--json"]);
  return { ...result, report: result.status === 0 ? (JSON.parse(result.stdout) as JsonReport) : undefined };
}

describe("tree mode", () => {
  it("scans every file and reports zones per file", () => {
    const dir = tempDir();
    write(dir, "src/Api.php", "<?php\nif ( current_user_can( 'edit_posts' ) ) {}\n$x = $_POST['a'];\n");
    write(dir, "assets/app.js", "el.innerHTML = html;\n");
    write(dir, "assets/app.css", ".a { color: red; }\n");
    write(dir, "composer.json", "{}\n");
    const { status, report } = scan(dir);
    expect(status).toBe(0);
    expect(report!.mode).toBe("tree");
    expect(report!.config.source).toBe("builtin");
    expect(report!.summary.filesScanned).toBe(4);
    expect(report!.files.map((file) => [file.file, file.zones])).toEqual([
      ["assets/app.js", ["input"]],
      ["composer.json", ["guardrails"]],
      ["src/Api.php", ["authz", "input"]],
    ]);
  });

  it("skips vendor and node_modules", () => {
    const dir = tempDir();
    write(dir, "vendor/lib/a.php", "<?php eval($x);\n");
    write(dir, "node_modules/lib/a.js", "eval(x);\n");
    write(dir, "src/ok.php", "<?php echo 1;\n");
    expect(scan(dir).report!.summary.matches).toBe(0);
  });

  it("skips build output, which repeats the source it was built from", () => {
    const dir = tempDir();
    write(dir, "dist/app.js", "el.innerHTML = html;\n");
    write(dir, "build/app.js", "el.innerHTML = html;\n");
    write(dir, "src/app.js", "el.innerHTML = html;\n");
    expect(scan(dir).report!.files.map((file) => file.file)).toEqual(["src/app.js"]);
  });

  it("scans the directory named by --path and reads sensitive.yml from there", () => {
    const dir = tempDir();
    write(dir, ".pipeline/sensitive.yml", "paths:\n  - path: 'billing/**'\n    zone: privacy\n");
    write(dir, "billing/a.txt", "x\n");
    const other = tempDir();
    const { report } = scan(other, ["--path", dir]);
    expect(report!.config.source).toBe("file");
    expect(report!.files.map((file) => [file.file, file.zones])).toEqual([["billing/a.txt", ["privacy"]]]);
  });

  it("prints readable text without --json", () => {
    const dir = tempDir();
    write(dir, "a.php", "<?php\n$x = $_GET['a'];\n");
    const { stdout, status } = pipeline(dir, ["scan-zones"]);
    expect(status).toBe(0);
    expect(stdout).toContain("a.php  [input]  1 match");
    expect(stdout).toContain("line 2 [input] $x = $_GET['a'];");
    expect(stdout).toContain("1 files scanned, 1 in zones, 1 matches, 0 removed signals (input: 1).");
  });
});

describe("--staged", () => {
  it("scans only the staged changes", () => {
    const repo = makeRepo();
    stage(repo, "a.php", "<?php\n$ok = 1;\n");
    commit(repo, "feat: add a");
    stage(repo, "a.php", "<?php\n$ok = 1;\n$x = $_POST['a'];\n");
    write(repo, "b.php", "<?php\n$y = $_GET['b'];\n");
    const { report } = scan(repo, ["--staged"]);
    expect(report!.mode).toBe("staged");
    expect(report!.files.map((file) => [file.file, file.matches.map((match) => match.line)])).toEqual([["a.php", [3]]]);
  });

  it("still scans a change to build output", () => {
    const repo = makeRepo();
    stage(repo, "dist/app.js", "el.innerHTML = html;\n");
    const { report } = scan(repo, ["--staged"]);
    expect(report!.files.map((file) => [file.file, file.zones])).toEqual([["dist/app.js", ["input"]]]);
  });

  it("lists a removed nonce check first, before the added matches", () => {
    const repo = makeRepo();
    stage(repo, "save.php", "<?php\nfunction save() {\n  check_ajax_referer( 'save' );\n  update_option( 'a', 1 );\n}\n");
    commit(repo, "feat: save");
    stage(repo, "save.php", "<?php\nfunction save() {\n  $x = $_POST['a'];\n  update_option( 'a', $x );\n}\n");
    const { report } = scan(repo, ["--staged"]);
    expect(report!.removed).toEqual([
      expect.objectContaining({ file: "save.php", line: 3, zone: "csrf", text: "check_ajax_referer( 'save' );" }),
    ]);
    const text = pipeline(repo, ["scan-zones", "--staged"]).stdout;
    expect(text.indexOf("Weakened controls")).toBeGreaterThan(-1);
    expect(text.indexOf("Weakened controls")).toBeLessThan(text.indexOf("Files in human review zones"));
    expect(text).toContain("save.php:3 [csrf] removed: check_ajax_referer( 'save' );");
  });

  it("flags a data write whose request data was already in the function", () => {
    const repo = makeRepo();
    stage(repo, "h.php", "<?php\nfunction h( $request ) {\n  $v = $request->get_param( 'v' );\n  return $v;\n}\n");
    commit(repo, "feat: h");
    stage(repo, "h.php", "<?php\nfunction h( $request ) {\n  $v = $request->get_param( 'v' );\n  update_option( 'v', $v );\n  return $v;\n}\n");
    const { report } = scan(repo, ["--staged"]);
    expect(report!.files).toEqual([expect.objectContaining({ file: "h.php", zones: ["input"], matchCount: 1 })]);
  });

  it("reports a deleted guardrail file by path and a deleted file's removed signals", () => {
    const repo = makeRepo();
    stage(repo, ".github/workflows/ci.yml", "name: ci\n");
    stage(repo, "gate.php", "<?php\nwp_verify_nonce( $n );\n");
    commit(repo, "feat: files");
    git(repo, "rm", "-q", ".github/workflows/ci.yml", "gate.php");
    const { report } = scan(repo, ["--staged"]);
    expect(report!.files.map((file) => file.file)).toEqual([".github/workflows/ci.yml", "gate.php"]);
    expect(report!.removed).toEqual([expect.objectContaining({ file: "gate.php", zone: "csrf" })]);
  });

  it("is empty when nothing is staged", () => {
    const repo = makeRepo();
    const { report } = scan(repo, ["--staged"]);
    expect(report!.summary.filesScanned).toBe(0);
  });

  it("uses the repo's sensitive.yml", () => {
    const repo = makeRepo();
    stage(repo, ".pipeline/sensitive.yml", "signals:\n  php:\n    - pattern: 'charge_card'\n      zone: privacy\n");
    commit(repo, "chore: rules");
    stage(repo, "pay.php", "<?php\ncharge_card();\n$a = $_GET['a'];\n");
    const { report } = scan(repo, ["--staged"]);
    expect(report!.config.source).toBe("file");
    expect(report!.files).toEqual([expect.objectContaining({ file: "pay.php", zones: ["privacy"] })]);
  });
});

describe("--range", () => {
  it("scans the net change between two commits", () => {
    const repo = makeRepo();
    const from = git(repo, "rev-parse", "HEAD").stdout.trim();
    stage(repo, "a.php", "<?php\n$x = $_POST['a'];\n");
    commit(repo, "feat: a");
    stage(repo, "b.php", "<?php\n$y = 1;\n");
    const to = commit(repo, "feat: b");
    const { report } = scan(repo, ["--range", `${from}..${to}`]);
    expect(report!.mode).toBe("range");
    expect(report!.files.map((file) => file.file)).toEqual(["a.php"]);
    expect(report!.summary.filesScanned).toBe(2);
  });

  it("reports a control removed in the range", () => {
    const repo = makeRepo();
    stage(repo, "a.php", "<?php\nif ( current_user_can( 'x' ) ) {}\n");
    const from = commit(repo, "feat: a");
    stage(repo, "a.php", "<?php\n");
    const to = commit(repo, "fix: drop check");
    const { report } = scan(repo, ["--range", `${from}..${to}`]);
    expect(report!.removed).toEqual([expect.objectContaining({ file: "a.php", zone: "authz", line: 2 })]);
  });

  it("scans a root commit through a range that starts at its missing parent", () => {
    const repo = tempDir();
    git(repo, "init", "-q", "-b", "main");
    stage(repo, "a.php", "<?php\n$x = $_POST['a'];\n");
    const root = commit(repo, "feat: a");
    const { status, report } = scan(repo, ["--range", `${root}^..${root}`]);
    expect(status).toBe(0);
    expect(report!.files.map((file) => file.file)).toEqual(["a.php"]);
    expect(report!.summary.filesScanned).toBe(1);
  });

  it("scans both commits from a root parent and only the second from the root itself", () => {
    const repo = tempDir();
    git(repo, "init", "-q", "-b", "main");
    stage(repo, "a.php", "<?php\n$x = $_POST['a'];\n");
    const root = commit(repo, "feat: a");
    stage(repo, "b.php", "<?php\n$y = $_GET['b'];\n");
    const tip = commit(repo, "feat: b");
    const all = scan(repo, ["--range", `${root}^..${tip}`]).report!;
    expect(all.files.map((file) => file.file)).toEqual(["a.php", "b.php"]);
    const after = scan(repo, ["--range", `${root}..${tip}`]).report!;
    expect(after.files.map((file) => file.file)).toEqual(["b.php"]);
    expect(scan(repo, ["--range", `${tip}^..${tip}`]).report!.files.map((file) => file.file)).toEqual(["b.php"]);
    expect(scan(repo, ["--range", `${root}~1..${tip}`]).report!.files.map((file) => file.file)).toEqual(["a.php", "b.php"]);
  });

  it("still rejects a missing parent of a commit that has parents, and an unknown base", () => {
    const repo = makeRepo();
    const root = git(repo, "rev-parse", "HEAD").stdout.trim();
    stage(repo, "a.php", "<?php\n");
    const tip = commit(repo, "feat: a");
    expect(pipeline(repo, ["scan-zones", "--range", `${root}^^..${tip}`]).stderr).toContain("is not a commit");
    expect(pipeline(repo, ["scan-zones", "--range", `nope^..${tip}`]).stderr).toContain("is not a commit");
  });

  it("rejects a malformed or unknown range", () => {
    const repo = makeRepo();
    expect(pipeline(repo, ["scan-zones", "--range", "main"]).status).toBe(2);
    expect(pipeline(repo, ["scan-zones", "--range", "nope..HEAD"]).stderr).toContain('"nope" is not a commit');
  });
});

describe("usage errors", () => {
  it("exits 2 for conflicting modes and for a directory that is not a repo", () => {
    const dir = tempDir();
    expect(pipeline(dir, ["scan-zones", "--staged", "--range", "a..b"]).status).toBe(2);
    expect(pipeline(dir, ["scan-zones", "--staged"]).stderr).toContain("git repository");
    expect(pipeline(dir, ["scan-zones", "--bogus"]).status).toBe(2);
  });

  it("exits 2 and names the file for an invalid sensitive.yml", () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".pipeline"));
    writeFileSync(join(dir, ".pipeline", "sensitive.yml"), "signals:\n  php:\n    - pattern: x\n      zone: nope\n");
    const result = pipeline(dir, ["scan-zones"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(".pipeline/sensitive.yml");
  });

  it("prints its usage for --help", () => {
    const { stdout, status } = pipeline(tempDir(), ["scan-zones", "--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("--staged");
    expect(stdout).toContain("docs/zones.md");
  });
});
