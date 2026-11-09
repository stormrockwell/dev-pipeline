import { afterAll, describe, expect, it } from "vitest";
import { commit, git, makeRepo, pipeline, removeTemps, stage, tempDir, write } from "../helpers/repo.ts";

afterAll(removeTemps);

interface JsonResult {
  tier: string;
  name: string;
  zones: string[];
  reasons: { file: string; tier: string; rule: string; zone?: string; line?: number | null }[];
  files: { file: string; tier: string; zones: string[] }[];
}

function classify(cwd: string, args: string[]) {
  const result = pipeline(cwd, ["classify", ...args, "--json"]);
  return { ...result, json: result.status === 0 ? (JSON.parse(result.stdout) as JsonResult) : undefined };
}

describe("files", () => {
  it("classifies named files from the working tree", () => {
    const dir = tempDir();
    write(dir, "README.md", "# Hi\n");
    write(dir, "a.css", ".a{}\n");
    write(dir, "src/a.php", "<?php\nif ( current_user_can( 'x' ) ) {}\n");
    expect(classify(dir, ["README.md", "a.css"]).json).toMatchObject({ tier: "T1", name: "Presentation", zones: [] });
    const { json, status } = classify(dir, ["README.md", "src/a.php"]);
    expect(status).toBe(0);
    expect(json).toMatchObject({ tier: "T3", zones: ["authz"] });
    expect(json!.reasons).toEqual([expect.objectContaining({ file: "src/a.php", rule: "zone", zone: "authz", line: 2 })]);
  });

  it("classifies a path that does not exist by its name alone", () => {
    const dir = tempDir();
    expect(classify(dir, ["docs/new.md"]).json!.tier).toBe("T0");
    expect(classify(dir, [".github/workflows/ci.yml"]).json!.tier).toBe("T3");
  });

  it("reads sensitive.yml from --path", () => {
    const dir = tempDir();
    write(dir, ".pipeline/sensitive.yml", "paths:\n  - path: 'billing/**'\n    zone: privacy\n");
    write(dir, "billing/a.txt", "x\n");
    const result = classify(tempDir(), ["--path", dir, "billing/a.txt"]);
    expect(result.json).toMatchObject({ tier: "T3", zones: ["privacy"] });
  });

  it("prints tier, zones and reasons as text", () => {
    const dir = tempDir();
    write(dir, "src/a.php", "<?php\n$x = $_POST['a'];\n");
    const { stdout, status } = pipeline(dir, ["classify", "src/a.php"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Tier: T3 (Sensitive)");
    expect(stdout).toContain("Zones: input");
    expect(stdout).toContain("src/a.php:2  zone:input");
  });
});

describe("--staged and --range", () => {
  it("classifies the staged diff", () => {
    const repo = makeRepo();
    stage(repo, "docs/a.md", "text\n");
    expect(classify(repo, ["--staged"]).json).toMatchObject({ tier: "T0" });
    stage(repo, "src/a.php", "<?php\n$ok = 1;\n");
    expect(classify(repo, ["--staged"]).json).toMatchObject({ tier: "T2" });
    stage(repo, "src/b.php", "<?php\n$v = $_GET['v'];\n");
    expect(classify(repo, ["--staged"]).json).toMatchObject({ tier: "T3", zones: ["input"] });
  });

  it("is T0 when nothing is staged", () => {
    expect(classify(makeRepo(), ["--staged"]).json).toMatchObject({ tier: "T0", files: [] });
  });

  it("classifies a range and counts a removed control", () => {
    const repo = makeRepo();
    stage(repo, "a.php", "<?php\nfunction f() {\n  wp_verify_nonce( $n, 'a' );\n}\n");
    const from = commit(repo, "feat: a");
    stage(repo, "a.php", "<?php\nfunction f() {\n}\n");
    const to = commit(repo, "fix: simplify");
    const { json } = classify(repo, ["--range", `${from}..${to}`]);
    expect(json).toMatchObject({ tier: "T3", zones: ["csrf"] });
    expect(json!.reasons).toEqual([expect.objectContaining({ rule: "removed-signal", zone: "csrf", line: 3 })]);
    expect(git(repo, "status", "--short").stdout).toBe("");
  });
});

describe("usage errors", () => {
  it("needs files, --staged or --range", () => {
    const result = pipeline(tempDir(), ["classify"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("give files, --staged or --range");
  });

  it("rejects mixing modes", () => {
    const repo = makeRepo();
    expect(pipeline(repo, ["classify", "--staged", "a.php"]).status).toBe(2);
    expect(pipeline(repo, ["classify", "--staged", "--range", "a..b"]).status).toBe(2);
  });

  it("shows usage for --help", () => {
    const { stdout, status } = pipeline(tempDir(), ["classify", "--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("T0");
  });
});
