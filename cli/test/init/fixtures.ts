import { commit, git, stage, tempDir, write } from "../helpers/repo.ts";

function repoWith(commits: string[]): string {
  const repo = tempDir("pipeline-init-");
  const init = git(repo, "init", "-q", "-b", "main");
  if (init.status !== 0) throw new Error(init.stderr);
  stage(repo, ".gitignore", "node_modules/\nvendor/\n");
  commit(repo, commits[0] ?? "initial");
  return repo;
}

function history(repo: string, messages: string[]): void {
  messages.forEach((message, index) => {
    stage(repo, `notes/${index}.md`, `note ${index}\n`);
    commit(repo, message);
  });
}

// A WordPress plugin with unit and integration suites, a JS build, linters and its own CI.
export function wordpressPluginRepo(): string {
  const repo = repoWith(["chore: initial commit"]);
  write(
    repo,
    "acme-widgets.php",
    `<?php
/**
 * Plugin Name: Acme Widgets
 * Description: Widgets for Acme.
 * Version: 1.4.0
 * Requires PHP: 8.1
 * Text Domain: acme-widgets
 */

defined( 'ABSPATH' ) || exit;
`,
  );
  write(
    repo,
    "composer.json",
    JSON.stringify(
      {
        name: "acme/widgets",
        require: { php: ">=8.1" },
        "require-dev": { "phpunit/phpunit": "^9.6", "squizlabs/php_codesniffer": "^3.7" },
      },
      null,
      2,
    ),
  );
  write(
    repo,
    "phpunit.xml.dist",
    `<phpunit><testsuites>
  <testsuite name="unit"><directory>tests/Unit</directory></testsuite>
  <testsuite name="integration"><directory>tests/Integration</directory></testsuite>
</testsuites></phpunit>
`,
  );
  write(repo, "phpcs.xml.dist", '<ruleset name="Acme"><rule ref="WordPress"/></ruleset>\n');
  write(repo, "tests/Unit/WidgetTest.php", "<?php\nclass WidgetTest {}\n");
  write(repo, "tests/Unit/PriceTest.php", "<?php\nclass PriceTest {}\n");
  write(repo, "tests/Integration/RestTest.php", "<?php\nclass RestTest {}\n");
  write(repo, "includes/auth/login.php", "<?php\n");
  write(repo, "includes/class-widget.php", "<?php\n");
  write(
    repo,
    "package.json",
    JSON.stringify(
      {
        name: "acme-widgets",
        scripts: { build: "wp-scripts build", "test:js": "wp-scripts test-unit-js" },
        devDependencies: { "@wordpress/scripts": "^30.0.0", eslint: "^9.0.0", stylelint: "^14.16.1", jest: "^29.0.0" },
      },
      null,
      2,
    ),
  );
  write(repo, "package-lock.json", "{}\n");
  write(repo, "src/index.js", "export const a = 1;\n");
  write(repo, "src/index.test.js", "test('a', () => {});\n");
  write(repo, "eslint.config.mjs", "export default [];\n");
  write(repo, ".stylelintrc.json", "{}\n");
  write(repo, ".github/workflows/ci.yml", "name: CI\non: [push]\njobs: {}\n");
  write(repo, ".github/CODEOWNERS", "* @acme/maintainers\n");
  write(repo, ".github/pull_request_template.md", "## Summary\n");
  git(repo, "add", "-A");
  commit(repo, "feat: add the widget plugin");
  history(repo, ["fix(rest): validate the widget id", "feat(admin): add a settings page", "chore: bump dev tools"]);
  return repo;
}

// A Next.js site on pnpm with Vitest and Playwright, no CI, and free-form commit messages.
export function nodeSiteRepo(): string {
  const repo = repoWith(["Initial commit"]);
  write(
    repo,
    "package.json",
    JSON.stringify(
      {
        name: "corner-bakery",
        private: true,
        scripts: { dev: "next dev", build: "next build", test: "vitest run" },
        engines: { node: ">=22" },
        dependencies: { next: "^15.0.0", react: "^19.0.0" },
        devDependencies: { vitest: "^5.0.0", "@playwright/test": "^1.60.0", eslint: "^9.0.0" },
      },
      null,
      2,
    ),
  );
  write(repo, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(repo, ".nvmrc", "v22.11.0\n");
  write(repo, "vitest.config.ts", "export default {};\n");
  write(repo, "playwright.config.ts", "export default {};\n");
  write(repo, "eslint.config.mjs", "export default [];\n");
  write(repo, "src/app/page.tsx", "export default function Page() { return null; }\n");
  write(repo, "src/app/billing/route.ts", "export function GET() {}\n");
  write(repo, "src/page.test.ts", "import { it } from 'vitest';\nit('x', () => {});\n");
  write(repo, "e2e/home.spec.ts", "import { test } from '@playwright/test';\n");
  git(repo, "add", "-A");
  commit(repo, "Add the home page");
  history(repo, ["Fix the menu", "Update copy", "Tweak styles"]);
  return repo;
}

// A package with an entry point and no framework, which is a library and not a site.
export function nodeLibraryRepo(): string {
  const repo = repoWith(["Initial commit"]);
  write(
    repo,
    "package.json",
    JSON.stringify({ name: "tiny-lib", main: "dist/index.js", exports: "./dist/index.js", devDependencies: { mocha: "^10.0.0" } }),
  );
  write(repo, "package-lock.json", "{}\n");
  git(repo, "add", "-A");
  commit(repo, "Add the package");
  return repo;
}
