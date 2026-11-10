import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { entriesFor, nextVersion, writeChangelog } from "../src/commands/version-sync/changelog.ts";
import { findLocations } from "../src/commands/version-sync/locations.ts";
import { commit, git, makeRepo, pipeline, removeTemps, stage, tempDir, write } from "./helpers/repo.ts";

afterAll(removeTemps);

const plugin = (version: string, constant = version) => `<?php
/**
 * Plugin Name: Shop Demo
 * Version: ${version}
 */

define( 'SHOP_DEMO_VERSION', '${constant}' );
`;

function pluginDir(header = "1.2.0", tag = "1.2.0"): string {
  const dir = tempDir();
  write(dir, "shop-demo.php", plugin(header));
  write(dir, "readme.txt", `=== Shop Demo ===\nRequires at least: 6.4\nStable tag: ${tag}\n\n== Description ==\nA shop.\n`);
  write(dir, "package.json", `{\n  "name": "shop-demo",\n  "version": "${header}",\n  "private": true\n}\n`);
  write(dir, "includes/other.php", "<?php\n/**\n * Plugin Name: Not the main file\n * Version: 9.9.9\n */\n");
  return dir;
}

describe("findLocations", () => {
  it("finds the plugin header, its constant, the readme tag and package.json, and nothing below the root", () => {
    expect(findLocations(pluginDir()).map((location) => [location.file, location.kind, location.version])).toEqual([
      ["shop-demo.php", "plugin header", "1.2.0"],
      ["shop-demo.php", "constant SHOP_DEMO_VERSION", "1.2.0"],
      ["readme.txt", "readme stable tag", "1.2.0"],
      ["package.json", "package.json version", "1.2.0"],
    ]);
  });

  it("leaves out a stable tag of trunk, and finds a theme header", () => {
    const dir = tempDir();
    write(dir, "style.css", "/*\nTheme Name: Shop\nVersion: 2.0.1\n*/\n");
    write(dir, "functions.php", "<?php\nconst SHOP_VERSION = '2.0.1';\n");
    write(dir, "readme.txt", "Stable tag: trunk\n");
    expect(findLocations(dir).map((location) => location.kind)).toEqual(["theme header", "constant SHOP_VERSION"]);
  });
});

describe("pipeline version-sync", () => {
  it("passes when every location agrees", () => {
    const { status, stdout } = pipeline(pluginDir(), ["version-sync"]);
    expect(stdout).toBe("version-sync: 4 locations agree on 1.2.0\n");
    expect(status).toBe(0);
  });

  it("fails and lists each location when they disagree", () => {
    const { status, stdout } = pipeline(pluginDir("1.2.0", "1.1.0"), ["version-sync"]);
    expect(status).toBe(1);
    expect(stdout).toContain("- readme.txt:3  readme stable tag  1.1.0");
  });

  it("sets every location to one version and touches nothing else", () => {
    const dir = pluginDir("1.2.0", "1.1.0");
    expect(pipeline(dir, ["version-sync", "set", "1.3.0"]).status).toBe(0);
    expect(pipeline(dir, ["version-sync"]).stdout).toBe("version-sync: 4 locations agree on 1.3.0\n");
    expect(readFileSync(join(dir, "shop-demo.php"), "utf8")).toBe(plugin("1.3.0"));
    expect(readFileSync(join(dir, "includes/other.php"), "utf8")).toContain("9.9.9");
    expect(pipeline(dir, ["version-sync", "set", "next"]).status).toBe(2);
  });

  it("says when a repo has no version strings", () => {
    expect(pipeline(tempDir(), ["version-sync"]).stdout).toContain("no version strings found");
  });
});

describe("changelog entries", () => {
  it("maps features, fixes and performance work, and skips the rest", () => {
    const entries = entriesFor([
      { subject: "feat(export): add a CSV export", body: "" },
      { subject: "fix: ship free at the threshold.", body: "" },
      { subject: "perf(orders): cache the order count", body: "" },
      { subject: "docs: explain the export", body: "" },
      { subject: "Merge branch main", body: "" },
    ]);
    expect(entries).toEqual({
      bump: "minor",
      sections: { Added: ["Add a CSV export."], Fixed: ["Ship free at the threshold."], Changed: ["Cache the order count."] },
    });
  });

  it("makes a breaking change major and says so in the entry", () => {
    const entries = entriesFor([{ subject: "refactor!: rename the export hook", body: "" }, { subject: "fix: x", body: "BREAKING CHANGE: the filter is gone" }]);
    expect(entries.bump).toBe("major");
    expect(entries.sections.Changed).toEqual(["Breaking: Rename the export hook."]);
    expect(entries.sections.Fixed).toEqual(["Breaking: X."]);
  });

  it("works out the next version, keeping 0.x below 1.0.0", () => {
    expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(nextVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
    expect(nextVersion("0.4.1", "major")).toBe("0.5.0");
    expect(nextVersion("1.2.3", "none")).toBeNull();
  });

  it("adds entries under Unreleased once, in section order, above earlier releases", () => {
    const dir = tempDir();
    write(dir, "CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Old fix.\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- First release.\n");
    const entries = { bump: "minor" as const, sections: { Added: ["New thing."], Fixed: ["New fix."] } };
    expect(writeChangelog(dir, entries)).toEqual(["New thing.", "New fix."]);
    expect(writeChangelog(dir, entries)).toEqual([]);
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toBe(
      "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- New thing.\n\n### Fixed\n\n- New fix.\n- Old fix.\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- First release.\n",
    );
  });

  it("creates a Keep a Changelog file when there is none", () => {
    const dir = tempDir();
    writeChangelog(dir, { bump: "patch", sections: { Fixed: ["A fix."] } });
    const text = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    expect(text).toContain("[Keep a Changelog](https://keepachangelog.com/en/1.1.0/)");
    expect(text.endsWith("## [Unreleased]\n\n### Fixed\n\n- A fix.\n")).toBe(true);
  });
});

describe("pipeline version-sync changelog", () => {
  function repo(distributed: boolean): { repo: string; base: string } {
    const repo = makeRepo();
    stage(repo, "shop-demo.php", plugin("1.2.0"));
    stage(repo, ".pipeline/profile.yml", `project:\n  type: wp-plugin\n  distributed: ${distributed}\n`);
    const base = commit(repo, "chore: add the plugin");
    stage(repo, "a.txt", "a");
    commit(repo, "feat(shipping): ship free at the threshold");
    stage(repo, "b.txt", "b");
    commit(repo, "test: cover the threshold");
    return { repo, base };
  }

  it("writes the entries and names the release bump in a distributed project", () => {
    const { repo: dir, base } = repo(true);
    const { status, stdout } = pipeline(dir, ["version-sync", "changelog", "--range", `${base}..HEAD`, "--write"]);
    expect(status).toBe(0);
    expect(stdout).toBe("version-sync: added 1 entries under Unreleased in CHANGELOG.md\nRelease   minor bump, 1.2.0 to 1.3.0\n");
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toContain("### Added\n\n- Ship free at the threshold.\n");
  });

  it("keeps no changelog for a single deployment", () => {
    const { repo: dir, base } = repo(false);
    expect(pipeline(dir, ["version-sync", "changelog", "--range", `${base}..HEAD`, "--write"]).stdout).toContain("keeps no changelog");
    expect(git(dir, "status", "--porcelain").stdout).toBe("");
  });

  it("needs a range", () => {
    expect(pipeline(tempDir(), ["version-sync", "changelog"]).status).toBe(2);
  });
});
