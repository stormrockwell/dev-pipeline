import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { commit, git, makeRepo, pipeline, removeTemps, stage, tempDir, write } from "../helpers/repo.ts";

afterAll(removeTemps);

interface JsonReport {
  summary: { filesScanned: number; matches: number };
  files: { file: string; zones: string[] }[];
}

function scan(cwd: string, args: string[] = []): JsonReport {
  const result = pipeline(cwd, ["scan-zones", ...args, "--json"]);
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as JsonReport;
}

const sink = "el.innerHTML = html;\n";

describe("tree mode inside a git repo", () => {
  it("reads only the files git would commit", () => {
    const repo = makeRepo({ gitignore: ".env\nnode_modules/\npublic/build/\n.next/\n.claude/\ngenerated.js\n" });
    stage(repo, "src/app.js", sink);
    commit(repo, "feat: add app");
    write(repo, "src/untracked.js", sink);
    write(repo, "public/build/bundle.js", sink);
    write(repo, ".next/server.js", sink);
    write(repo, ".claude/settings.json", "{}\n");
    write(repo, ".env", "KEY=1\n");
    write(repo, "generated.js", sink);
    const report = scan(repo);
    expect(report.files.map((file) => file.file)).toEqual(["src/app.js", "src/untracked.js"]);
  });

  it("scans a tracked file even when a later ignore rule would match it", () => {
    const repo = makeRepo();
    stage(repo, "keep.js", sink);
    commit(repo, "feat: add keep");
    write(repo, ".gitignore", "keep.js\n");
    expect(scan(repo).files.map((file) => file.file)).toContain("keep.js");
  });

  it("scans committed build output, because a plugin ships it", () => {
    const repo = makeRepo();
    stage(repo, "dist/app.js", sink);
    stage(repo, "build/app.js", sink);
    commit(repo, "build: commit output");
    expect(scan(repo).files.map((file) => file.file)).toEqual(["build/app.js", "dist/app.js"]);
  });

  it("still skips committed vendor and node_modules code", () => {
    const repo = makeRepo();
    stage(repo, "vendor/lib/a.js", sink);
    stage(repo, "web/node_modules/lib/a.js", sink);
    commit(repo, "chore: vendor");
    expect(scan(repo).summary.matches).toBe(0);
  });

  it("ignores a tracked file that was deleted from the working tree", () => {
    const repo = makeRepo();
    stage(repo, "gone.js", sink);
    commit(repo, "feat: add gone");
    rmSync(join(repo, "gone.js"));
    expect(scan(repo).files).toEqual([]);
  });

  it("skips symlinks, as the directory walk always did", () => {
    const repo = makeRepo();
    stage(repo, "real.js", sink);
    symlinkSync("real.js", join(repo, "link.js"));
    git(repo, "add", "link.js");
    commit(repo, "feat: link");
    expect(scan(repo).files.map((file) => file.file)).toEqual(["real.js"]);
  });

  it("lists paths relative to --path when it names a subdirectory", () => {
    const repo = makeRepo();
    stage(repo, "pkg/src/a.js", sink);
    write(repo, "pkg/ignored/b.js", sink);
    stage(repo, ".gitignore", "ignored/\n");
    commit(repo, "feat: pkg");
    expect(scan(repo, ["--path", join(repo, "pkg")]).files.map((file) => file.file)).toEqual(["src/a.js"]);
  });
});

describe("tree mode outside a git repo", () => {
  it("keeps the name based skip of build output and dependencies", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src"), { recursive: true });
    write(dir, "dist/app.js", sink);
    write(dir, "build/app.js", sink);
    write(dir, "vendor/a.js", sink);
    write(dir, "node_modules/a.js", sink);
    write(dir, "src/app.js", sink);
    expect(scan(dir).files.map((file) => file.file)).toEqual(["src/app.js"]);
  });
});
