import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../src/commands/scan-zones/config.ts";
import { parseYaml, type YamlValue } from "../../src/commands/scan-zones/yaml.ts";
import { git, pipeline, removeTemps, tempDir, write } from "../helpers/repo.ts";
import { nodeSiteRepo, wordpressPluginRepo } from "./fixtures.ts";

// Fixtures run many git commands, which slow down when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

afterAll(removeTemps);

type Tree = { [key: string]: YamlValue };

function readYaml(repo: string, path: string): Tree {
  return parseYaml(readFileSync(join(repo, path), "utf8")) as Tree;
}

function init(repo: string, ...args: string[]) {
  return pipeline(repo, ["init", "--path", repo, ...args]);
}

describe("init on an existing WordPress plugin", () => {
  const repo = wordpressPluginRepo();
  const result = init(repo, "--answer", "distributed=no");

  it("succeeds and names the mode it chose", () => {
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("mode: existing");
  });

  it("writes a profile from what it found", () => {
    const profile = readYaml(repo, ".pipeline/profile.yml");
    expect(profile.project).toMatchObject({ type: "wordpress-plugin", name: "Acme Widgets", distributed: false, php: "8.1" });
    expect(profile.git).toEqual({ default_branch: "main", strategy: "trunk", merge: "squash", commits: "conventional" });
    expect(profile.tests).toEqual({ unit: "tests/Unit", integration: "tests/Integration", js: "jest", e2e: "none" });
    expect(profile.policy).toMatchObject({ tdd: "always" });
  });

  it("writes sensitive.yml with the WordPress pack, in a form scan-zones reads", () => {
    const text = readFileSync(join(repo, ".pipeline/sensitive.yml"), "utf8");
    const config = parseConfig(text);
    expect(readYaml(repo, ".pipeline/sensitive.yml").packs).toEqual(["wordpress"]);
    expect(config.signals.length).toBeGreaterThan(0);
  });

  it("changes nothing outside .pipeline", () => {
    const status = git(repo, "status", "--porcelain").stdout.trim().split("\n");
    expect(status).toEqual(["?? .pipeline/"]);
  });

  it("prints the next steps for what the repo lacks", () => {
    expect(result.stdout).toContain("pipeline hooks install");
    expect(result.stdout).toContain("templates/github/pipeline.yml");
  });
});

describe("init on an existing Node site", () => {
  const repo = nodeSiteRepo();
  const result = init(repo, "--answer", "urls=/,/menu/");

  it("asks nothing it can detect, so only the URLs are answered", () => {
    expect(result.status, result.stderr).toBe(0);
    const profile = readYaml(repo, ".pipeline/profile.yml");
    expect(profile.project).toMatchObject({ type: "node-site", node: "22", framework: "next" });
    expect(profile.accessibility).toEqual({ target: "wcag22aa", urls: ["/", "/menu/"] });
    expect(profile.tests).toEqual({ js: "vitest", e2e: "playwright" });
    expect(profile.git).toMatchObject({ commits: "free" });
  });

  it("selects the Node pack and adds the path rule that detection found", () => {
    const sensitive = readYaml(repo, ".pipeline/sensitive.yml");
    expect(sensitive.packs).toEqual(["node"]);
    expect(sensitive.paths).toEqual([{ path: "**/billing/**", zone: "privacy" }]);
    parseConfig(readFileSync(join(repo, ".pipeline/sensitive.yml"), "utf8"));
  });
});

describe("init answers", () => {
  it("fails with exit 2 and writes nothing when a question has no answer", () => {
    const repo = wordpressPluginRepo();
    const result = init(repo);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("distributed");
    expect(result.stderr).toContain("--answer distributed=");
    expect(existsSync(join(repo, ".pipeline"))).toBe(false);
  });

  it("takes every answer from a file, so evals need no TTY", () => {
    const repo = wordpressPluginRepo();
    const file = join(tempDir(), "answers.yml");
    writeFileSync(file, "distributed: yes\n");
    const result = init(repo, "--answers", file);
    expect(result.status, result.stderr).toBe(0);
    expect(readYaml(repo, ".pipeline/profile.yml").project).toMatchObject({ distributed: true });
  });

  it("records a missing suite as an open TDD question for the work order", () => {
    const repo = tempDir();
    git(repo, "init", "-q", "-b", "main");
    write(repo, "package.json", '{"name":"bare","dependencies":{"express":"^4"}}');
    const result = init(repo, "--answer", "type=node-site", "--answer", "urls=/");
    expect(result.status, result.stderr).toBe(0);
    expect(readYaml(repo, ".pipeline/profile.yml").policy).toMatchObject({ tdd: "ask" });
  });
});

describe("init never overwrites without saying so", () => {
  it("keeps an existing profile and names it", () => {
    const repo = wordpressPluginRepo();
    write(repo, ".pipeline/profile.yml", "project:\n  type: custom\n");
    const result = init(repo, "--answer", "distributed=no");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("kept .pipeline/profile.yml");
    expect(readFileSync(join(repo, ".pipeline/profile.yml"), "utf8")).toBe("project:\n  type: custom\n");
    expect(existsSync(join(repo, ".pipeline/sensitive.yml"))).toBe(true);
  });

  it("overwrites only with --force, and says so", () => {
    const repo = wordpressPluginRepo();
    write(repo, ".pipeline/profile.yml", "project:\n  type: custom\n");
    const result = init(repo, "--answer", "distributed=no", "--force");
    expect(result.stdout).toContain("overwrote .pipeline/profile.yml");
    expect(readFileSync(join(repo, ".pipeline/profile.yml"), "utf8")).toContain("wordpress-plugin");
  });

  it("reports a second run as unchanged", () => {
    const repo = wordpressPluginRepo();
    init(repo, "--answer", "distributed=no");
    const again = init(repo, "--answer", "distributed=no");
    expect(again.stdout).toContain("unchanged .pipeline/profile.yml");
    expect(again.stdout).toContain("unchanged .pipeline/sensitive.yml");
  });

  it("writes nothing in a dry run", () => {
    const repo = wordpressPluginRepo();
    const result = init(repo, "--answer", "distributed=no", "--dry-run");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would create .pipeline/profile.yml");
    expect(existsSync(join(repo, ".pipeline"))).toBe(false);
  });
});

describe("init and GitHub", () => {
  it("prints the settings commands and never runs gh", () => {
    const repo = wordpressPluginRepo();
    const bin = tempDir();
    const log = join(bin, "gh.log");
    mkdirSync(bin, { recursive: true });
    const fakeGh = join(bin, "gh");
    writeFileSync(fakeGh, `#!/bin/sh\necho "$@" >> ${log}\n`);
    chmodSync(fakeGh, 0o755);
    const path = `${bin}:/usr/bin:/bin`;
    const result = pipeline(repo, ["init", "--path", repo, "--answer", "distributed=no", "--repo", "acme/widgets"], {
      env: { PATH: `${path}:${process.env.PATH ?? ""}` },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("not run");
    expect(result.stdout).toContain("gh api --method POST repos/acme/widgets/rulesets");
    expect(result.stdout).toContain("gh label create");
    expect(existsSync(log)).toBe(false);
  });

  it("leaves a placeholder for the repo when none is known", () => {
    const repo = wordpressPluginRepo();
    const result = init(repo, "--answer", "distributed=no");
    expect(result.stdout).toContain("pipeline github commands --repo <owner>/<name>");
  });
});

describe("init help", () => {
  it("documents the modes, the answer inputs and the no overwrite rule", () => {
    const result = pipeline(tempDir(), ["init", "--help"]);
    expect(result.status).toBe(0);
    for (const text of ["existing", "new", "--answer", "--answers", "--force", "--dry-run", "never runs gh"]) {
      expect(result.stdout).toContain(text);
    }
  });
});

describe("init mode", () => {
  it("treats a directory with no project files as a new project", () => {
    const dir = tempDir();
    const result = pipeline(dir, ["init", "--path", dir, "--dry-run", "--answer", "type=node-site", "--answer", "public=no", "--answer", "peer_review=no"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("mode: new");
  });

  it("rejects an unknown mode", () => {
    const dir = tempDir();
    expect(pipeline(dir, ["init", "--mode", "both"]).status).toBe(2);
  });

  it("hashes the same files on a rerun", () => {
    const repo = nodeSiteRepo();
    init(repo, "--answer", "urls=/");
    const hash = () => createHash("sha256").update(readFileSync(join(repo, ".pipeline/profile.yml"))).digest("hex");
    const before = hash();
    init(repo, "--answer", "urls=/");
    expect(hash()).toBe(before);
  });
});
