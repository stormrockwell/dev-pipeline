import { afterAll, describe, expect, it, vi } from "vitest";
import { detectProfile } from "../../src/commands/init/detect.ts";
import { removeTemps, tempDir, write } from "../helpers/repo.ts";
import { nodeLibraryRepo, nodeSiteRepo, wordpressPluginRepo } from "./fixtures.ts";

// Fixtures run many git commands, which slow down when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

afterAll(removeTemps);

describe("a WordPress plugin", () => {
  const found = detectProfile(wordpressPluginRepo());

  it("is recognised by its plugin header", () => {
    expect(found.type).toBe("wordpress-plugin");
    expect(found.name).toBe("Acme Widgets");
    expect(found.evidence.join("\n")).toContain("acme-widgets.php");
  });

  it("reads the PHP floor from the plugin header before composer.json", () => {
    expect(found.versions.php).toBe("8.1");
  });

  it("finds both package managers and every language in use", () => {
    expect(found.packageManagers).toEqual(["npm", "composer"]);
    expect(found.languages).toEqual(expect.arrayContaining(["php", "javascript"]));
  });

  it("finds the suites with their directories and a test file count", () => {
    expect(found.tests.unit).toBe("tests/Unit");
    expect(found.tests.integration).toBe("tests/Integration");
    expect(found.tests.js).toBe("jest");
    expect(found.tests.e2e).toBeUndefined();
    expect(found.tests.files).toBe(4);
  });

  it("finds the linters", () => {
    expect(found.linters).toEqual(expect.arrayContaining(["phpcs", "eslint", "stylelint"]));
    expect(found.linters).not.toContain("phpstan");
  });

  it("finds the CI workflows, CODEOWNERS and the PR template", () => {
    expect(found.ci.workflows).toEqual([".github/workflows/ci.yml"]);
    expect(found.ci.pipeline).toBe(false);
    expect(found.codeowners).toBe(true);
    expect(found.prTemplate).toBe(true);
  });

  it("reads the branch and the commit style from git", () => {
    expect(found.git.isRepo).toBe(true);
    expect(found.git.defaultBranch).toBe("main");
    expect(found.git.commits).toBe("conventional");
  });

  it("names the directories that deserve a path rule beyond the built in packs", () => {
    expect(found.zoneDirs).toEqual([]);
  });
});

describe("a Node site", () => {
  const found = detectProfile(nodeSiteRepo());

  it("is recognised by its framework", () => {
    expect(found.type).toBe("node-site");
    expect(found.framework).toBe("next");
    expect(found.name).toBe("corner-bakery");
  });

  it("uses the lockfile to pick the package manager", () => {
    expect(found.packageManagers).toEqual(["pnpm"]);
  });

  it("reads the Node version from .nvmrc", () => {
    expect(found.versions.node).toBe("22");
  });

  it("finds Vitest and Playwright and counts the test files", () => {
    expect(found.tests.js).toBe("vitest");
    expect(found.tests.e2e).toBe("playwright");
    expect(found.tests.unit).toBeUndefined();
    expect(found.tests.files).toBe(2);
  });

  it("finds ESLint and reports that there is no CI", () => {
    expect(found.linters).toEqual(["eslint"]);
    expect(found.ci.workflows).toEqual([]);
    expect(found.codeowners).toBe(false);
  });

  it("reports free form commits", () => {
    expect(found.git.commits).toBe("free");
  });

  it("lists the directories that call for a path rule", () => {
    expect(found.zoneDirs).toEqual([{ glob: "**/billing/**", zone: "privacy" }]);
  });
});

describe("other layouts", () => {
  it("calls a package with an entry point and no framework a library", () => {
    const found = detectProfile(nodeLibraryRepo());
    expect(found.type).toBe("node-library");
    expect(found.tests.js).toBe("mocha");
  });

  it("recognises a WordPress theme by style.css", () => {
    const dir = tempDir();
    write(dir, "style.css", "/*\nTheme Name: Plain\n*/\n");
    write(dir, "functions.php", "<?php\n");
    expect(detectProfile(dir).type).toBe("wordpress-theme");
  });

  it("returns unknown for an empty directory, without git", () => {
    const found = detectProfile(tempDir());
    expect(found.type).toBe("unknown");
    expect(found.git.isRepo).toBe(false);
    expect(found.git.commits).toBe("unknown");
    expect(found.tests.files).toBe(0);
  });

  it("flags an existing pipeline workflow", () => {
    const dir = tempDir();
    write(dir, ".github/workflows/pipeline.yml", "jobs:\n  pipeline:\n    uses: stormrockwell/dev-pipeline/.github/workflows/pipeline-pr.yml@abc\n");
    expect(detectProfile(dir).ci.pipeline).toBe(true);
  });

  it("does not count dependencies as the project's own tests", () => {
    const dir = tempDir();
    write(dir, "package.json", '{"name":"x","dependencies":{"express":"^4"}}');
    write(dir, "node_modules/left-pad/index.test.js", "");
    write(dir, "vendor/pkg/FooTest.php", "");
    expect(detectProfile(dir).tests.files).toBe(0);
  });
});
