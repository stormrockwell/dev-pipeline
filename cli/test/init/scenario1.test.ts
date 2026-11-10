import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectProfile } from "../../src/commands/init/detect.ts";
import { parseConfig } from "../../src/commands/scan-zones/config.ts";
import { parseYaml, type YamlValue } from "../../src/commands/scan-zones/yaml.ts";
import { git, pipeline, removeTemps, tempDir } from "../helpers/repo.ts";

// Fixtures run many git commands, which slow down when the whole suite runs in parallel.

afterAll(removeTemps);

const sha = "0123456789abcdef0123456789abcdef01234567";
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const yaml = (dir: string, path: string) => parseYaml(read(dir, path)) as { [key: string]: YamlValue };

function scaffold(dir: string, ...extra: string[]) {
  return pipeline(tempDir(), [
    "init",
    "--mode",
    "new",
    "--path",
    dir,
    "--answer",
    "type=node-site",
    "--answer",
    "name=demo-site",
    "--answer",
    "public=no",
    "--answer",
    "peer_review=no",
    "--pipeline-ref",
    sha,
    ...extra,
  ]);
}

// Puts executables that exit 0 where `pipeline check` looks for a project's own tools.
function fakeTool(dir: string, name: string, exit = 0): void {
  const bin = join(dir, "node_modules/.bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), `#!/bin/sh\nexit ${exit}\n`);
  chmodSync(join(bin, name), 0o755);
}

describe("scenario 1: a fresh Node demo site, bootstrap checks", () => {
  const dir = join(tempDir(), "demo-site");
  let result: ReturnType<typeof scaffold>;

  beforeAll(() => {
    result = scaffold(dir);
  });

  it("scaffolds without a TTY and exits 0", () => {
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("mode: new");
  });

  it("creates a git repo on main", () => {
    expect(git(dir, "symbolic-ref", "--short", "HEAD").stdout.trim()).toBe("main");
  });

  it("writes the base configs, without the WordPress layer", () => {
    const eslint = read(dir, "eslint.config.mjs");
    expect(eslint).toContain("@digitalimpulse/coding-standards/eslint/base");
    expect(read(dir, ".stylelintrc.cjs")).toContain("@digitalimpulse/coding-standards/stylelint/base");
    expect(read(dir, ".prettierrc.cjs")).toContain("@digitalimpulse/coding-standards/prettier");
    expect(read(dir, "tsconfig.json")).toContain("@digitalimpulse/coding-standards/tsconfig/base.json");
    expect(existsSync(join(dir, ".editorconfig"))).toBe(true);
    for (const file of ["eslint.config.mjs", ".stylelintrc.cjs", "package.json"]) {
      expect(read(dir, file).toLowerCase(), file).not.toContain("wordpress");
    }
    expect(existsSync(join(dir, "phpcs.xml"))).toBe(false);
  });

  it("sets up a Vitest suite and a Playwright smoke test with axe", () => {
    expect(existsSync(join(dir, "vitest.config.ts"))).toBe(true);
    expect(read(dir, "tests/page.test.ts")).toContain("expect(");
    expect(read(dir, "playwright.config.ts")).toContain("webServer");
    const smoke = read(dir, "e2e/smoke.spec.ts");
    expect(smoke).toContain("@axe-core/playwright");
    expect(smoke).toContain("analyze()");
  });

  it("pins the standards and the tools in package.json and installs hooks through prepare", () => {
    const manifest = JSON.parse(read(dir, "package.json")) as {
      name: string;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.name).toBe("demo-site");
    // A bare prepare script would fail npm ci in CI, where the CLI is not on the PATH yet.
    expect(manifest.scripts.prepare).toMatch(/^pipeline hooks install \|\| echo 'warning/);
    expect(manifest.scripts.test).toBe("vitest run");
    expect(manifest.devDependencies["@digitalimpulse/coding-standards"]).toMatch(
      /^git\+https:\/\/github\.com\/stormrockwell\/coding-standards\.git#[0-9a-f]{40}$/,
    );
    for (const tool of ["vitest", "eslint", "stylelint", "prettier", "typescript", "@playwright/test", "@axe-core/playwright"]) {
      expect(manifest.devDependencies[tool], tool).toMatch(/^\^\d/);
    }
  });

  it("writes the CI caller workflow from the template with the pinned commit", () => {
    const workflow = read(dir, ".github/workflows/pipeline.yml");
    expect(workflow).toContain(`stormrockwell/dev-pipeline/.github/workflows/pipeline-pr.yml@${sha}`);
    expect(workflow).toContain(`cli-ref: ${sha}`);
    expect(workflow).not.toContain("REPLACE_WITH_SHA");
    expect(workflow).toMatch(/^\s+enforce-approvals: false/m);
    expect(read(dir, ".github/pull_request_template.md")).toBe(read(repoRoot, ".github/pull_request_template.md"));
  });

  it("keeps enforcement on and leaves the placeholder when it is not told otherwise", () => {
    const other = join(tempDir(), "other");
    const run = pipeline(tempDir(), [
      "init", "--mode", "new", "--path", other,
      "--answer", "type=node-site", "--answer", "public=no", "--answer", "peer_review=yes",
    ]);
    expect(run.status, run.stderr).toBe(0);
    const workflow = read(other, ".github/workflows/pipeline.yml");
    expect(workflow).toContain("REPLACE_WITH_SHA");
    expect(workflow).not.toMatch(/^\s+enforce-approvals: false/m);
    expect(run.stdout).toContain("REPLACE_WITH_SHA");
  });

  it("covers .env files in .gitignore and creates none", () => {
    const ignore = read(dir, ".gitignore").split("\n");
    expect(ignore).toContain(".env*");
    expect(ignore).toContain("!.env.example");
    expect(ignore).toContain("node_modules/");
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("writes the profile and sensitive.yml with the Node pack", () => {
    const profile = yaml(dir, ".pipeline/profile.yml");
    expect(profile.project).toMatchObject({ type: "node-site", name: "demo-site", public: false });
    expect(profile.tests).toEqual({ js: "vitest", e2e: "playwright" });
    expect(profile.git).toMatchObject({ default_branch: "main", strategy: "trunk", merge: "squash", commits: "conventional" });
    expect(profile.policy).toMatchObject({ tdd: "always" });
    expect(yaml(dir, ".pipeline/sensitive.yml").packs).toEqual(["node"]);
    parseConfig(read(dir, ".pipeline/sensitive.yml"));
  });

  it("writes a short CLAUDE.md of navigation pointers", () => {
    const text = read(dir, "CLAUDE.md");
    expect(text).toContain(".pipeline/profile.yml");
    expect(text.split("\n").length).toBeLessThan(40);
  });

  it("installs the secret hooks", () => {
    expect(read(dir, ".git/hooks/pre-commit")).toContain("secrets --staged");
    expect(read(dir, ".git/hooks/pre-push")).toContain("secrets --range");
    expect(pipeline(dir, ["hooks", "status"]).status).toBe(0);
  });

  it("prints the GitHub commands and the repo creation as text, and runs none", () => {
    expect(result.stdout).toContain("not run");
    expect(result.stdout).toContain("gh repo create <owner>/demo-site --private --source . --remote origin");
    expect(result.stdout).toContain("pipeline github commands --repo <owner>/<name>");
  });

  it("passes pipeline check, with the project's own tools reported as missing until they are installed", () => {
    const check = pipeline(dir, ["check", "--path", dir, "--json"]);
    expect(check.status, check.stdout).toBe(0);
    const report = JSON.parse(check.stdout) as { ok: boolean; tools: { tool: string; status: string }[] };
    expect(report.ok).toBe(true);
    const statuses = Object.fromEntries(report.tools.map((tool) => [tool.tool, tool.status]));
    expect(statuses.eslint).toBe("missing");
    expect(statuses.stylelint).toBe("missing");
  });

  it("passes pipeline check with the tools present, and fails when one of them fails", () => {
    fakeTool(dir, "eslint");
    fakeTool(dir, "stylelint");
    const passing = JSON.parse(pipeline(dir, ["check", "--path", dir, "--json"]).stdout) as { tools: { tool: string; status: string }[] };
    expect(passing.tools.filter((tool) => ["eslint", "stylelint"].includes(tool.tool)).map((tool) => tool.status)).toEqual(["passed", "passed"]);

    fakeTool(dir, "eslint", 1);
    expect(pipeline(dir, ["check", "--path", dir]).status).toBe(1);
    fakeTool(dir, "eslint");
  });

  it("is detected as the same project when init runs again in existing mode", () => {
    const found = detectProfile(dir);
    expect(found.type).toBe("node-site");
    expect(found.tests.js).toBe("vitest");
    expect(found.tests.e2e).toBe("playwright");
    expect(found.linters).toEqual(expect.arrayContaining(["eslint", "stylelint", "prettier"]));
    expect(found.ci.pipeline).toBe(true);
    expect(found.versions.node).toMatch(/^\d+$/);
  });

  it("changes nothing on a second run, and says so", () => {
    const before = read(dir, "package.json");
    const again = scaffold(dir);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).not.toMatch(/^(overwrote|created) /m);
    expect(read(dir, "package.json")).toBe(before);
  });
});

describe("new project in a directory that already holds files", () => {
  it("keeps every existing file and names it", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), '{"name":"mine"}\n');
    writeFileSync(join(dir, ".gitignore"), "custom\n");
    const run = scaffold(dir);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("kept package.json");
    expect(run.stdout).toContain("kept .gitignore");
    expect(read(dir, "package.json")).toBe('{"name":"mine"}\n');
    expect(read(dir, ".gitignore")).toBe("custom\n");
    expect(existsSync(join(dir, "vitest.config.ts"))).toBe(true);
  });
});

describe("a new WordPress plugin", () => {
  const dir = join(tempDir(), "acme-sync");

  beforeAll(() => {
    const run = pipeline(tempDir(), [
      "init", "--mode", "new", "--path", dir,
      "--answer", "type=wordpress-plugin", "--answer", "name=Acme Sync",
      "--answer", "distributed=yes", "--answer", "peer_review=no", "--pipeline-ref", sha,
    ]);
    if (run.status !== 0) throw new Error(run.stderr);
  });

  it("writes the plugin header with Requires PHP 8.0, and an uninstall routine", () => {
    const main = read(dir, "acme-sync.php");
    expect(main).toContain("Plugin Name: Acme Sync");
    expect(main).toContain("Requires PHP: 8.0");
    expect(main).toContain("defined( 'ABSPATH' ) || exit;");
    expect(read(dir, "uninstall.php")).toContain("WP_UNINSTALL_PLUGIN");
  });

  it("sets up PHPUnit and PHPCS with the DemandDrive standard, and the WordPress layer for JS and CSS", () => {
    const composer = JSON.parse(read(dir, "composer.json")) as { require: Record<string, string>; "require-dev": Record<string, string> };
    expect(composer.require.php).toBe(">=8.0");
    expect(Object.keys(composer["require-dev"])).toEqual(expect.arrayContaining(["phpunit/phpunit", "digitalimpulse/php-coding-standards"]));
    expect(read(dir, "phpcs.xml")).toContain('<rule ref="DemandDrive"/>');
    expect(read(dir, "phpunit.xml.dist")).toContain("tests/Unit");
    expect(existsSync(join(dir, "tests/Unit"))).toBe(true);
    expect(read(dir, "eslint.config.mjs")).toContain("eslint/wordpress");
    expect(read(dir, ".stylelintrc.cjs")).toContain("stylelint/wordpress");
  });

  it("writes a profile with the PHP floor and the WordPress pack", () => {
    expect(yaml(dir, ".pipeline/profile.yml").project).toMatchObject({ type: "wordpress-plugin", distributed: true, php: "8.0" });
    expect(yaml(dir, ".pipeline/sensitive.yml").packs).toEqual(["wordpress"]);
  });

  it("passes pipeline check and is detected as a plugin", () => {
    const check = pipeline(dir, ["check", "--path", dir]);
    expect(check.status, check.stdout).toBe(0);
    const found = detectProfile(dir);
    expect(found.type).toBe("wordpress-plugin");
    expect(found.versions.php).toBe("8.0");
    expect(found.tests.unit).toBe("tests/Unit");
  });
});

