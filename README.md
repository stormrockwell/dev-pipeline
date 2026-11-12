# Dev Pipeline

A Claude Code development pipeline for secure, testable PHP and JavaScript web projects. Start with `docs/STRATEGY.md`, then `docs/PLAN.md`.

Read the docs at https://stormrockwell.github.io/dev-pipeline/, including the [pipeline flow chart](https://stormrockwell.github.io/dev-pipeline/pipeline-flow.html). To preview them locally, run `npm install` and `npm run dev` in `tools/docs`.

## Set up a machine

| Tool | Version in use | Why |
|---|---|---|
| Node | 24 (`cli/package.json` requires 24 or later) | the CLI, the docs viewer and the plugin tests |
| npm | 11 | dependency installs |
| Claude Code | 2.1.322 or later | the plugin, agents and `claude plugin eval` |
| gh | 2.95 or later, logged in with `gh auth login` | PRs, checks and labels |
| git | 2.50 or later | worktrees |
| PHP | 8.3 CLI or later, and the suites pass on 8.5 (WordPress plugins target 8.0 and up) | phpcs and the WordPress fixtures |
| Composer | 2.10 | PHP dependency installs and `composer audit` |
| Python | 3.10 or later, for a venv | installing semgrep |
| semgrep | 1.184.0, the version CI pins | the floor's static analysis |
| gitleaks | 8.30.1, the version CI pins | the floor's secret scan |
| MySQL client | optional | the one worktree test that skips without it |

On macOS with Homebrew:

```sh
brew install node@24 gh php composer gitleaks
brew install python@3.13
/opt/homebrew/bin/python3.13 -m venv ~/.venvs/semgrep && ~/.venvs/semgrep/bin/pip install semgrep==1.184.0
ln -s ~/.venvs/semgrep/bin/semgrep /opt/homebrew/bin/semgrep
npm install -g @anthropic-ai/claude-code
gh auth login
```

macOS ships Python 3.9 as `/usr/bin/python3`, and pip offers it nothing newer than semgrep 1.136.0, so the venv needs Homebrew's Python. `/usr/local/bin` is owned by root on Apple silicon, so link semgrep into `/opt/homebrew/bin` instead.

When nvm manages Node, run `nvm install 24 && nvm alias default 24` in place of `node@24`. A Claude Code session started before that keeps the old Node on its PATH, and the CLI then fails with `ERR_UNKNOWN_FILE_EXTENSION` on `main.ts`. Restart the session, or put `~/.nvm/versions/node/v24.*/bin` first on PATH.

Check that Homebrew's gitleaks matches 8.30.1, and install the release binary from GitHub if it does not. Then, in the repo:

```sh
cd cli && npm ci && cd ..
cd tools/docs && npm ci && cd ..
cli/bin/pipeline check    # should print 4 passed, 0 failed, 0 missing
cd cli && npx vitest run  # the CLI suite
node --test plugin/test/*.test.mjs
```

`pipeline a11y` scans pages with axe-core in a headless Chromium. `npm ci` installs Playwright and axe-core as optional dependencies, and the browser is a separate download, so run `cd cli && npx playwright-core install chromium` once. Without them the rest of the CLI works and `pipeline a11y` prints the install line and exits 1. The vitest browser cases skip themselves when the browser is missing.

At session start the plugin reminds you to run `/compound` once a week. Set `compound: lead` in `~/.pipeline/config.yml` if you are the pipeline's project lead, so your reminder also covers the team's merged PRs, or `compound: manual` to turn it off. The default is `weekly`.

`.claude/settings.json` is committed, so the permission denials, `gh pr merge` among them, come with the clone.

### Reference clones

`research/` is git-ignored and holds the sources the strategy cites. Clone them again on a new machine when a task needs them:

```sh
mkdir -p research && cd research
git clone https://github.com/obra/superpowers obra_superpowers
git clone https://github.com/prime-radiant-inc/superpowers-evals prime-radiant_superpowers-evals
git clone https://github.com/mattpocock/skills mattpocock_skills
git clone https://github.com/alibaba/open-code-review alibaba_open-code-review
git clone https://github.com/cloudflare/security-audit-skill cloudflare_security-audit-skill
git clone https://github.com/demanddrive/coding-standards demanddrive_coding-standards
```

The standards fork in use is `stormrockwell/coding-standards`.
