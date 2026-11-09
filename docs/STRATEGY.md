# Dev Pipeline Strategy

This document proposes a development system for PHP and JavaScript web projects, built on Claude Code. The system produces secure, testable, readable code by enforcing best practices, and it enforces how pull requests, comments and commits are written. It draws on a review of Superpowers and its eval lab, Matt Pocock's skills, Open Code Review, Cloudflare's security-audit skill, the DemandDrive coding standards and current Claude Code features. The research clones live in `research/`.

## 1. The strategy in brief

1. **No commands to remember.** A router reads every request and picks the lightest route that fits: answer, report, quick change, change, debug, new project or spike. On the change route the orchestrator drafts the tasks, classifies each one, proposes a work order with the gates it will run, and waits for one confirmation before it dispatches anything. `/work` and the other commands stay as optional shortcuts.
2. **Risk tiers decide the gates.** A deterministic classifier reads each task's planned files, and later the actual diff, and assigns a tier per task. A CSS-only change gets a light security pass and no TDD. A REST endpoint change gets a security review, mandatory human review and TDD, which is recommended rather than assumed only in an existing codebase without a test suite.
3. **Sensitive code is isolated for human review.** Authentication, authorization, input handling, queries, uploads, secrets, dependencies, CI and the pipeline's own guardrails are human review zones. The pipeline moves the whole component's logic for a zone into its own PR, and GitHub enforces one or two human approvals on it. Low-risk changes can need zero human approvals once the metrics show it is safe.
4. **The floor runs whether or not anyone remembers the process.** Linters, static analysis, secret scanning, dependency audits and automated accessibility checks run through hooks and CI on every change. Nobody can skip them, and they cost almost nothing.
5. **Friction is proportional to risk.** Skipping a gate on a low tier takes one word. Human review on a sensitive change cannot be skipped.
6. **Discover before enforcing.** Init reads an existing repo first (tests, linters, branch strategy, commit style, versioning) and proposes an adoption plan. New projects always get a test suite, TDD, and linters built on the DemandDrive coding standards, and TDD is assumed wherever a test suite exists. Only an existing codebase without a test suite gets a question instead. The work order asks whether to use TDD, recommends it for large or sensitive work, and never sets up a harness for a couple of low-risk functions.
7. **Deterministic where it must not fail, agents where judgment matters.** Scripts select files, match rules, classify risk, check comments and PR length, and diff designs against Figma. Agents implement, judge and explain.
8. **Standards live with the reviewer.** The implementer gets a short brief. The reviewers carry the full coding, comment and security standards, because they work from a diff with the least context pressure.
9. **The compounder turns failures into checks.** Mechanical lessons become linter rules and hooks. Judgment lessons become reviewer standards. Every change to an agent ships with an eval case, and `claude plugin eval` measures it against a no-plugin baseline. The objective is the least human attention per PR, and revert and incident rates are the guardrail.
10. **Serial by default, parallel when nothing overlaps.** Tasks run one at a time, as in Superpowers. Tasks that share no files, interfaces or state run in parallel to save time, each in its own worktree with its own test database and cloned dependencies, so WordPress suites stop colliding.
11. **Security outranks every other reviewer.** Every change gets a security review, scaled from a light pass on styling and docs to a full review on sensitive code, and every new commit gets a fresh one. When reviewers disagree, security wins, then correctness, then readability, then performance.
12. **Secrets never reach the server.** Secret scans block every commit and every push on the laptop, and GitHub's push protection blocks at the server, because a pushed secret is compromised even if the next commit deletes it.

## 2. What the research shows

### Superpowers

Superpowers gets the execution mechanics right. Keep these parts:

- A fresh implementer subagent per task, dispatched with a brief file instead of pasted history.
- A ledger file that survives compaction, and a recorded ruling for every decision the controller takes on the user's behalf.
- Explicit model choice per dispatch. Its own measurements show the cheapest models take two to three times the turns on multi-step work, so a mid-tier model is the floor for reviewers and prose-driven implementers.
- Review packages handed over as files, a capped fix loop with a breaker, and a single final fix wave.
- Workers never spawn their own reviewers, and reviewers treat the implementer's report as unverified claims.
- An eval lab (Quorum, in `superpowers-evals`) with planted-defect scenarios, private acceptance criteria and deterministic post-checks.

Change these parts:

- **Coercive triggering.** A session-start hook injects `using-superpowers`, which tells the model to invoke a skill on a 1% chance. That rule, plus a TDD skill that applies to every feature, is why it imposes TDD on repos that never had tests. Our orchestrator decides from the repo profile and the classifier. Only in an existing codebase without a test suite does it ask whether to use TDD at all, and it recommends TDD when the work is large or sensitive.
- **Inherently slow.** The SDD skill forbids parallel implementers. One shared working tree, per-task review ranges and interfaces carried from task to task all assume one task at a time, and its cost study treats wall-clock time as unconstrained. Notes from the Media Made Easy build add the plumbing causes: one machine-global SQLite test database, worktrees without `vendor/` or `node_modules/`, and concurrent commits racing one index. We keep serial as the default and run tasks with zero overlap in parallel, with section 11 removing the plumbing causes.
- **Spec and plan duplication.** Superpowers writes a spec and then a plan that restates it, and its eval lab now carries a `cost-spec-plan-duplication` scenario. We size the paperwork to the work.
- **Missing layers.** There is no security reviewer, design reviewer or compounding loop.
- **Cost profile.** Its strict-cost study measured about $13 per plan run on its benchmark project, with the Opus controller at roughly half. Controller turns are the biggest cost, so we move bookkeeping into scripts.

### Matt Pocock's skills

Pocock's repo supplies the design philosophy. Keep these ideas:

- Skills split into user-invoked orchestrators and model-invoked disciplines, with one router so humans remember a single command.
- Tests only at seams agreed with the user before any test is written.
- Two-axis review (standards and spec) in separate contexts, plus a Fowler smell baseline that the repo's own standards override.
- The `retro` rule. A mechanical violation becomes a deterministic check, and only a judgment call becomes a written standard.
- The review agent enforces standards because it has the least context pressure. `CLAUDE.md` holds navigation pointers only.
- `writing-for-agents`, which favors leading words, positive phrasing over prohibitions, pointers over inlined reference, and relentless pruning of no-ops.
- A PR body built from the smallest visual, before and after evidence, and a one-way or two-way door call.
- Tickets as a task graph with blocking edges, worked as a parallel frontier on an integration branch.
- The software-factory brakes (automated checks, automated review, human review), with every accelerator throttled until the brakes earn trust.

The gaps are enforcement and measurement. The skills are opt-in, so they guide an experienced engineer and do nothing for a developer who never invokes them. There is no security layer and no benchmark. We also depart from his user-invoked entry points, for the reason section 5 gives.

### Anthropic's own review pipeline

Anthropic published how the Claude Code team reviews code now that agents write most of it, and Jason Stanley analyzed it as a case study in rebuilding governance. Their pipeline has seven layers: verification before the PR (tests, build, linters and a fresh-context subagent review), parallel AI review, a blocking security review, required CI, human approval scaled by risk, a merge queue, and flags with fast rollback. Merged PRs doubled while reverts fell more than 40 percent, and PRs passing after one review cycle rose from 65 to 78 percent.

These mechanisms transfer directly:

- **The change sets the tier, not the author.** A classifier reads the diff and requires zero, one or two human approvals. A second classifier can add an approval but never removes one. Paths that owners mark sensitive, and CI workflows, always need a person.
- **Agents never fill a human slot.** Automated review can clear a low-risk change, and a bot approval never counts as a person's.
- **An approval covers one commit.** New commits dissolve earlier approvals.
- **A person is accountable for every change.** The requester counts as one reviewer for agent-written code, and only trusted, repo-listed authors get the lighter paths.
- **Findings are verified before they post.** Several agents hunt in parallel, and a separate group votes on each finding. Style is left to linters, findings are tagged Important, Nit or Pre-existing, and every finding gets an answer.
- **Review converges.** AI review stops at three rounds and asks whether the approach needs rethinking. Later rounds re-review only the new diff, report a bug class once instead of every instance, and never repeat a finding. Mean rounds to pass fell from 2.08 to 1.32.
- **`REVIEW.md` tells the reviewer what matters** in each part of the code and caps the nits, while `CLAUDE.md` describes the project.
- **Measure human attention.** They track approvals per PR, human comments, wait time, reverts and incidents, and revert and incident rates are the guardrail.

Stanley's caveat holds for us too. The pipeline decides whether a change is safe to ship, and whether the work should exist at all stays a human decision about direction, scope and taste.

### Open Code Review

OCR proves the hybrid model. Deterministic code selects files, bundles related files, matches path-scoped rules and corrects comment positions, and the agent only reviews. Its published benchmark shows higher precision than Claude Code with the same model at about one ninth of the tokens, with lower recall by design. Delegation mode (`ocr delegate preview` and `ocr delegate rule`) hands file selection and rule resolution to our Claude Code reviewer with no extra API key. It ships PHP and TypeScript rule sets, and project rules live in `.opencodereview/rule.json`.

One caution applies. Precision over recall suits standards review and does not suit security review, which needs recall. OCR's default of skipping test files stays, because the spec reviewer judges the tests.

### Cloudflare security-audit

The skill is a full multi-agent audit, too heavy for every PR. Its principles transfer directly:

- A finding needs a crossed trust boundary and a concrete result. A missing best practice is not a vulnerability.
- The agent that validates a finding is never the agent that found it.
- `needs_validation` records an exact unresolved fact and carries no severity.
- Severity anchors are tied to demonstrated impact.
- Each finding recommends the smallest effective fix at the last trusted decision point.
- A scoped run over a diff with the `quick` profile is the per-PR shape. The `deep` profile with a coverage ledger is the periodic audit.
- Its own test runs found that one pass catches about half of what repeated passes find, so periodic audits are additive.

It has no PHP or WordPress material, so we write a WordPress companion file of attack classes.

### DemandDrive coding standards

The repo gives us the PHP, JS and CSS baseline. The full `WordPress` PHPCS standard it extends already includes the `WordPress.Security` and `WordPress.DB.PreparedSQL` sniffs (output escaping, nonce verification, input sanitization, prepared SQL, safe redirects), which is a free deterministic security floor. Fix these issues before building on it:

- The sniff tests call `assertIsString` on literal arrays, so they never run a sniff. They should use the PHPCS sniff test framework with `.inc` fixtures. This is a textbook tautological test and a good first TDD exercise for the pipeline.
- The ESLint config uses the legacy `.eslintrc` format, which ESLint 9 deprecated in favor of flat config.
- One repo carries two version streams (`v0.1.1` for Composer, `v1.0.0` for npm) on shared tags. Prefixed tags or a single version would remove the ambiguity.
- The repo has no CI, so the standards are not tested on change.
- The names disagree. The repo is `demanddrive`, and the packages are `digitalimpulse`.
- `react-hooks/exhaustive-deps` is off. That rule catches real bugs, so the choice deserves a recorded decision.
- The ESLint and Stylelint configs extend the WordPress presets, and the PHP ruleset builds on the WordPress standard. A non-WordPress project, such as a Node site, needs the same rules without the WordPress layer, so each config should split into a base and a WordPress layer.

Every new project starts from this repo, and it becomes the home for every mechanical rule the compounder produces, including custom sniffs, Semgrep rules and ESLint rules.

### Claude Code features to build on

- **`claude plugin eval`** runs each case three times with the plugin and three times without it, reports the difference, sandboxes Bash, seeds git fixtures through scaffold scripts, caps cost and gates CI on a threshold. Graders cover regex, tool use, tool order, file existence and model-judged rubrics. There are no custom-code graders, so a case writes its result to a file and a regex grades the file.
- **Sandboxing** confines Bash writes to the working directory and routes network traffic through an allowlist proxy, using Seatbelt on macOS and bubblewrap on Linux.
- **Hooks** (PreToolUse, PostToolUse, Stop, SubagentStop, SessionStart) enforce rules without relying on the model's memory.
- **Worktree isolation** for subagents, and the Workflow tool in the current build, which scripts a subagent fan-out with JSON-schema outputs and resumable runs.
- **Figma's MCP server** exposes `get_design_context`, `get_metadata`, `get_screenshot` and `get_variable_defs`, and the Figma REST API exports frames and node geometry for scripts.
- **WordPress Playground CLI** runs PHPUnit inside a fresh WordPress per run with `npx @wp-playground/cli php --auto-mount`, with no Docker and no database server.

## 3. Design principles

1. **Deterministic where it must not fail.** Classification, file selection, gates, version sync and PR shape are scripts. Agents judge.
2. **The floor runs regardless.** Hooks and CI enforce the cheap checks on every route that writes code, whichever route the router picked.
3. **Friction follows risk.** Compliance is the easy path because the agent does the work. Skipping is where the effort goes.
4. **Lifetime decides, not size.** A 20-line throwaway script needs no TDD. In a new project or a repo with a test suite, a 20-line production helper still gets a test, because the test is cheap.
5. **Discover before enforcing.** Existing repos keep their conventions until the team agrees to change them.
6. **Standards live with the reviewer.** Implementers get one-line rules, and reviewers get the full standards.
7. **Least code wins.** Readability and ease of debugging outrank cleverness. Deleting code is the best fix.
8. **Every agent change is measured.** No prompt change ships without an eval that failed before and passes after.
9. **Waste always, scale on request.** A faster version that is also simpler is always taken. A faster version that adds complexity waits for the user to confirm the data will grow that large.
10. **Human reading time is the bottleneck.** Every word a person must read spends the scarcest resource in the pipeline. Human-facing output leads with what needs a decision and stops when it is complete, and machine detail goes into the gate record.

## 4. Human review zones

Some code always gets a human reviewer, and the pipeline keeps that code separate so the human can review it properly.

### What counts as a zone

A change enters a human review zone when it matches a path rule or a content signal. Both live in `.pipeline/sensitive.yml`, which team leads own. The categories are:

- Authentication and sessions, such as login, password reset, cookies, JWT and OAuth.
- Authorization, such as capability checks, REST permission callbacks, role changes and `nopriv` handlers.
- CSRF protection, such as nonce creation and verification.
- Input reaching a dangerous sink, such as superglobals, raw queries, deserialization, shell execution, dynamic includes, uploads, outbound requests and redirects.
- Browser sinks, such as `innerHTML`, `dangerouslySetInnerHTML`, `postMessage` and `new Function`.
- Third-party code and outbound loads, such as a new external script, iframe, form target, font or CSS import.
- New environment, credential or configuration files.
- Personal data being collected, logged or exported.
- Destructive data changes, such as schema changes, bulk deletes and uninstall routines.
- Cryptography and secrets.
- Security suppressions, such as `phpcs:ignore` on a security sniff, `eslint-disable` on `no-unsanitized`, `nosemgrep` and new static-analysis baseline entries.
- The guardrails themselves, meaning `.pipeline/`, `.github/`, `.claude/`, `CODEOWNERS`, linter configs and dependency manifests.

```yaml
# .pipeline/sensitive.yml
paths:
  - "**/auth/**"
  - "**/rest/**"
  - "**/*permission*"
  - "**/migrations/**"
  - "composer.{json,lock}"
  - "package{,-lock}.json"
  - ".github/**"
  - ".claude/**"
  - ".pipeline/**"
  - "**/.env*"
  - "**/*.{pem,key,p12}"
  - "**/{auth.json,wp-config*.php,.htaccess}"
signals:
  php:
    - '\$_(GET|POST|REQUEST|COOKIE|SERVER|FILES)'
    - '\$wpdb->'
    - 'register_rest_route|permission_callback'
    - 'current_user_can|user_can|map_meta_cap'
    - 'wp_signon|wp_set_auth_cookie|wp_check_password|setcookie'
    - 'wp_ajax_nopriv_|check_ajax_referer|wp_verify_nonce'
    - 'unserialize|eval\(|shell_exec|proc_open|move_uploaded_file'
    - 'dbDelta|DROP TABLE|TRUNCATE|register_uninstall_hook'
  js:
    - 'innerHTML|insertAdjacentHTML|dangerouslySetInnerHTML'
    - 'postMessage|new Function'
  markup:
    - '<script[^>]+src=["'']https?://'
    - '<iframe|<form[^>]+action=["'']https?://'
    - 'javascript:|\son[a-z]+='
  css:
    - 'url\(["'']?https?://|@import'
  suppressions:
    - 'phpcs:ignore.*WordPress\.(Security|DB)'
    - 'eslint-disable.*no-unsanitized'
    - 'nosemgrep'
```

Two signals weigh more than the rest. A removed line that matched a signal, such as a deleted capability or nonce check, weakens a control, so the review guide lists it first. A change to the guardrails can weaken every future gate, so an agent can never land one without a human.

### How separation works

1. **At planning time**, the orchestrator puts zone work in its own tasks, and the zone PR carries all of that component's security logic, not scattered hunks. The reviewer then reads the whole control flow (input, check, action, output) in one place. The non-sensitive PR merges on its own path, stacked on or sequenced with the zone PR, and the zone PR waits for the right human.
2. **When the security logic is scattered**, the plan starts with a prefactor task that consolidates it into one module, such as a permission policy class or a single REST controller. This makes the zone change small, and it moves future zone detection from content signals to paths, which are cheaper and more reliable.
3. **When the zone work cannot stand alone**, it stays in one PR in dedicated commits, and the PR body opens with a "Human review required" section that links each file and line range.
4. **Before the PR opens**, a deterministic scan re-runs on the actual diff. Unplanned zone hunks raise the tier and notify the user. When a large PR buries a small zone change, the pipeline proposes the split and performs it in a worktree.
5. **On GitHub**, labels show each PR's risk and merge rules enforce it, as "Labels and merge rules" below describes.
6. **Agents advise, and humans approve.** An agent never approves a zone PR or marks it ready. Human review in a zone is part of the floor, so no involvement level and no bypass removes it. Repo policy only decides who may approve.

### How many humans

The tier sets the number of human approvals, and the author never does.

| Tier | Human approvals at launch | Target once metrics allow |
|---|---|---|
| T0 Docs, T1 Presentation | 1 | 0, after automated review and checks pass |
| T2 Logic | 1 | 1 |
| T3 Sensitive | 1 from zone approvers | 1 |
| T3 on designated paths (auth core, payments, CI workflows, pipeline guardrails) | 2, at least 1 from zone approvers | 2 |

The pipeline starts with a human on every PR and removes one only where the data supports it. A tier moves to zero approvals once its revert and incident rates stay flat over 100 merged PRs. That is the software-factory rule of opening the throttle as the brakes earn trust.

The requester owns every change the agent writes. Marking a draft PR ready is the requester's attestation that they read the diff. For trusted authors listed in the repo profile, that attestation counts as one approval, as at Anthropic. For everyone else, the required approvals come from people other than the requester, which steers newer developers toward a second pair of eyes without slowing seniors down.

The classification layers in section 6 (rules, then the security reviewer's zone call, then the orchestrator) can add an approval or a zone when they see risk the rules missed. None of them can remove one.

### Labels and merge rules

Every change goes through a PR, including the automatic path, so the floor, the agent reviews and the gate record run on all of it. Each PR carries one risk label:

| Label | Tasks | Required before merge |
|---|---|---|
| `risk:low` | T0, T1 | 1 approval until those tiers earn zero, then none |
| `risk:medium` | T2 | 1 approval |
| `risk:high` | T3 | 1 approval from zone approvers |
| `risk:critical` | T3 on designated paths | 2 approvals, at least one from zone approvers |

Zone labels say why a PR is sensitive: `zone:auth`, `zone:authz`, `zone:csrf`, `zone:input`, `zone:crypto`, `zone:secrets`, `zone:third-party`, `zone:privacy`, `zone:data-loss` and `zone:guardrails`. They route the review request to the right people and give the compounder clean data.

GitHub cannot require a reviewer because of a label. Rulesets can require approvals from a team for matching file paths (the required reviewers rule, with a minimum approval count), and CODEOWNERS works by path too, but neither reads labels. Enforcement therefore has two parts:

1. **Path zones use GitHub's native rules.** A ruleset on the default branch requires the zone approvers team for every path in `sensitive.yml`, with a minimum of two approvals on designated paths. This is the strongest guarantee, because nothing inside the PR can change it. Consolidating security logic into known modules moves more enforcement here over time.
2. **A `risk-gate` check covers the rest.** A small workflow runs on every push, label change and review, and its result is a required status check. It recomputes risk from the diff with the same scan the pipeline uses, takes the higher of that and the PR's labels, corrects the labels when they disagree, requests the required reviewers, and fails until the right approvals exist on the latest commit. Because it recomputes from the diff, removing a label never lowers the requirement. Marketplace actions such as label-required-approvals map labels to approvers and make a reasonable starting point, but they trust the label, so the gate adds the recomputation. Checking team membership needs a GitHub App token with organization members read access.

The ruleset also requires a PR for every change, dismisses stale approvals, requires approval of the latest push, requires `pipeline check`, the security status and `risk-gate`, blocks force pushes, and grants no bypass to bots or agents. Its own approval count stays at zero, because `risk-gate` sets the count per PR.

A `risk:low` PR that needs no approval still merges by a person. The requester merges it, or turns on auto-merge, once the checks pass. Agents never merge.

### The review guide

The security reviewer turns its output into a guide for the human, written as a list, not prose. It starts with the exact lines to read, then gives one line per trust boundary with the invariant it must hold and the tests that prove it, by name. The candidates the adversarial verifier rejected sit in a collapsed block for the reviewer who wants them. The human spends attention on what the agents could not prove.

### What a developer would miss

The pipeline assumes the developer may not recognize sensitive code, so no step relies on the developer's judgment to find it.

- **The developer cannot lower risk.** Anyone can raise a tier or add a zone. Removing a zone or lowering a T3 task needs a zone approver, so editing the work order to say "this is just a button" does not stick.
- **Three detectors run independently.** At planning, the rules and the orchestrator read each task. On the code, the rules and the security reviewer read every hunk. At merge, `risk-gate` recomputes risk in CI and GitHub's path rules apply. A zone missed at one point is caught at the next.
- **Reach counts.** A change to a function that zone code calls is zone code, even when the function looks harmless, such as a sanitizing helper or a query builder. The classifier finds the callers of every changed function with the language server or a symbol search, and raises the task when a caller sits in a zone.
- **Signals match the framework.** The WordPress signals miss Laravel's `Gate::allows`, Express middleware and Next.js API routes, so init picks a signal pack for each framework it detects, and the compounder adds patterns that slipped through.
- **Privacy and data loss are zones.** Collecting, logging or exporting personal data is `zone:privacy`. Schema changes, bulk deletes and uninstall routines are `zone:data-loss`, because they are one-way doors.
- **Vendored and built code counts.** A new minified or vendored file is `zone:third-party`. Committed build output gets rebuilt in CI with the pinned toolchain and must match, so nothing hides inside a bundle.
- **Security tests must bite.** On zone code, a mutation check disables each security check in a scratch copy and confirms that some test fails. A test that still passes with its check disabled proves nothing, so the PR blocks until the test is fixed. Infection for PHP and Stryker for JS can drive it.
- **Failures close the gate.** If the security reviewer, a scanner or `risk-gate` cannot run, the PR blocks instead of passing.
- **The agents are an attack surface.** Ticket text, PR comments, fetched docs and code comments are data, never instructions. Agents cannot read secrets, the sandbox's network allowlist blocks exfiltration, and changes to the pipeline's own config need a human.
- **Fresh clones get the hooks.** The package manager's install step installs the git hooks, so a fresh clone is protected after its first `composer install` or `npm install`. Push protection and CI catch anyone who removes them.
- **Rubber stamps show up.** The compounder compares each zone approval's time against the PR's size and flags approvals too fast to be a real review.
- **The map stays current.** The repo map from init re-runs on a schedule, so new sensitive modules get path rules instead of relying on content signals forever.

## 5. Routing and the flow

### Routes

Developers describe what they want in plain words. Nobody has to know a command, a skill name or a workflow.

| Route | Typical request | What runs | Writes to the repo |
|---|---|---|---|
| Answer | "what does this hook do?" | the main agent answers, reading code as needed | no |
| Report | "review this codebase and tell me how it works" | explorers map the code, and the writing agent produces the report | no; the report goes outside the repo |
| Quick change | a copy fix, a one-line style tweak | one implementer with the floor and a light security pass, and no work order screen | yes, through a PR |
| Change | a feature, a refactor, anything T2 or T3 | the full flow below, with a work order | yes, through PRs |
| Debug | "checkout is broken on staging" | the diagnosis loop, then the fix as a change | yes, through a PR |
| New project | "start a Node demo site from scratch" | bootstrap, then each feature as a change | yes |
| Spike | "quickly prototype a slider" | a prototype branch with the floor only | a branch that never merges |

### The router

The router is one model-invoked skill whose description covers any request to build, change, fix, review or explain code. A SessionStart hook adds a single line pointing to it, so it costs one line of context instead of a whole skill.

- **It names the route and why, in one line,** such as "Route: debug, because checkout returns a 500". The developer can redirect it with one word.
- **It picks the lightest route that fits.** Answer, report and quick change routes start right away. Anything that spins up several agents waits for the work order confirmation.
- **It asks one question when routes differ a lot in cost.** "Review this codebase" can mean explain it or audit it, and "a demo site" can be throwaway or maintained.
- **Commands stay as shortcuts.** `/work` forces the change route, `/review` a review and `/compound` the compounder, for people who know them. Nobody needs them.
- **A misroute costs efficiency, never safety,** because the floor, the security review and the merge rules run on every route that writes.
- **Redirects are routing errors.** The compounder turns each one into a router rule and an eval case.

This is a deliberate departure from Pocock. He keeps orchestrators user-invoked, so the human is the index of which skill to run. That suits experienced engineers and fails the people this pipeline most needs to help, who will not know what to use. His own framework says to spend cognitive load where human judgment matters and remove it where it does not, and choosing a skill is not where judgment matters. Superpowers shows the opposite risk, a router that forces process onto everything, so this router's first rule is the lightest route, and over-trigger cases in the eval suite hold it there.

### The change route

```
request routed to the change route
  1 Intake      read the profile, explore (notes go to a file), triage the request
                (spike or real work, rough size, obvious zone words)
  2 Shape       draft tasks and the files each one owns: the work order alone,
                a task graph, or spec and tickets for multi-session work
  3 Classify    tier, gates and zones per task; tasks grouped into PRs by
                human review path (zone, standard, automatic)
  4 Work order  one confirmation of tasks, tiers, gates and PR split
                (skipped at autopilot below T3)
  5 Build       one implementer per task in its own worktree, TDD at agreed seams
                (asked first only in existing code with no suite),
                fast checks enforced by a Stop hook
  6 Review      simplifier edits, then every applicable reviewer on the full diff;
                findings merged by precedence into one fix pass; each fix round
                re-reviews only the fix diff, routed to the reviewers it affects;
                security must pass the final commit, and its findings are never parked
  7 Finish      changelog and version sync*, PR body from ledger and diff,
                push the branch, open a draft PR, label zones
  8 Approve     humans approve on GitHub per tier; agents never fill a human slot
  9 Record      gates, skips, findings and cost written into the PR as hidden JSON
  * when the tier calls for it
```

Paperwork scales with the work. For a single task the work order is the plan. A medium change adds a task graph with file ownership to the same file. Only multi-session work gets a separate spec and tickets. Working files live in `.pipeline/work/<slug>/`, stay git-ignored, and are deleted after merge, because the PR and git history hold the record.

## 6. Risk tiers and the work order

| Tier | Typical change | Tests | Reviews | Human approvals |
|---|---|---|---|---|
| T0 Docs | Markdown, readme, copy | none | comment and PR standard, light security pass | 1, target 0 |
| T1 Presentation | CSS, SCSS, static markup | visual regression when a baseline exists, axe accessibility check | standards, light security pass, design when a Figma frame is linked | 1, target 0 |
| T2 Logic | PHP or JS behavior | TDD at agreed seams, axe check when markup or front-end JS changes | simplifier, standards, spec, quick security review, performance when data or request-path signals appear, accessibility when markup or front-end JS changes | 1 |
| T3 Sensitive | any human review zone | TDD plus security tests | simplifier (proposals only in zone code), standards, spec, full security review with a verifier vote, performance when signals appear | 1 from zone approvers, 2 on designated paths |
| Spike | throwaway, prototype, one-off script | none | none | cannot merge to the default branch |

In an existing codebase without a test suite, TDD in this table becomes a question in the work order, as section 8 describes.

The classifier assigns the tier from file types, zone signals, the repo profile and intent flags. Anyone can raise a tier, and only a zone approver can lower a T3 task or remove a zone. A PHP template that echoes variables is not "HTML only". The `EscapeOutput` sniff covers it for free, and an escaping change in a template is a zone signal.

### When classification runs

Risk is judged three times, at a finer grain each time, and each pass can only raise what the one before it set.

1. **Triage at intake.** The orchestrator reads the request and the explorer's notes and decides whether this is a spike or real work, how large it is, and how much shaping it needs. Obvious zone words such as login, payment or permissions put a human review flag on the work from the start.
2. **Per task, after shaping.** Each draft task declares the files it owns. The rules run on those files and on the task's description, and the orchestrator can raise the result. Each task gets its own tier and gates, so a CSV formatter gets TDD while the REST route beside it gets the full security review. The tasks are then grouped into PRs by human review path, as the next section describes.
3. **On the diff, every commit.** Plans miss things, so the rules and the security reviewer's zone tags run on the real hunks. A task that touched unplanned zone code is raised, and the user is told.

### From tasks to PRs

A tier belongs to a task, not to the plan. Agent reviews attach to each task wherever it lands, so a T2 task gets its quick security pass and a T1 task gets its accessibility check whichever PR carries them. The PR split therefore only decides human review, and tasks share a PR when they share a human review path.

| Review path | Tasks | Humans |
|---|---|---|
| Zone | T3 tasks, carrying all of the component's security logic | 1 from zone approvers, 2 on designated paths |
| Standard | T2 tasks, plus T0 and T1 tasks until those tiers earn zero approvals | 1 |
| Automatic | T0 and T1 tasks, once their revert rates earn zero approvals | 0 |

- A low-risk task never rides in a zone PR. A PR that mixed paths would take the strictest one, so a human would review low-risk code at the zone level for nothing.
- A task that cannot stand alone may join the PR it depends on, such as a one-line hook registration beside the code it registers. The work order says so when it happens.
- Dependencies set the merge order. Independent PRs merge as soon as they pass. A PR that needs another stacks on it, so the zone reviewer reads only zone code.
- The zone PR's review guide states the contract the other PRs rely on (the route's inputs, outputs and permission), so the reviewer can judge the sensitive code without reading the rest.
- A plan with one task stays one PR. Splitting only pays when there is more than one task.
- The diff pass can move work between PRs. A task whose real diff touches zone code moves to the zone PR, or its zone hunks do.

### Classification layers

Classification runs in layers at two points, and each layer can only raise what the layer before it decided.

At planning, on each task:

1. **Rules** run on the task's planned files and description, using path globs, file types and zone words from `sensitive.yml`.
2. **The orchestrator** reads every task with the explorer's notes and can raise the tier. This is where a vague request gets caught, such as "add an export button", which means data exposure and authorization even when no file name says so.

On the code, every commit:

1. **Rules** run on every hunk, matching paths, content signals and file types.
2. **The security reviewer's zone call.** The agentic security review reads every hunk of every change, so it tags each hunk with zone categories as part of its output. It catches what patterns miss, such as a custom wrapper around `$wpdb`, a helper that hides a capability check, or user data reaching output through a template helper.

Anyone can raise a tier. Lowering a T3 task or removing a zone needs a zone approver, as section 4 explains.

The work order fits on one screen:

```
Work order: add CSV export to the Orders REST endpoint
Task 1      CSV formatter                T2
Task 2      REST route and permissions   T3   security tests: subscriber denied,
                                              other author denied, output escaped;
                                              full security review
Task 3      Export button on Orders      T2   axe, accessibility pass
Reviews     simplifier, standards, spec and performance on every task
PR A        task 2, zone, approvers @org/security
PR B        tasks 1 and 3, stacked on PR A, 1 approval
Scale       up to 400 orders per export (profile); designing for more needs a yes
Skipped     design (no Figma frame linked)
Versioning  minor bump, changelog entry (distributed plugin)
Plan        serial, because each task builds on the last; about 14 agent runs
Reply "go", or edit a line.
```

In a new project or a repo with a test suite, TDD is assumed, so the work order lists only what differs from the default, and a task without TDD says why (a spike, a presentation-only change). In an existing codebase without a suite, the work order asks instead, with a recommendation sized to the work: `TDD  existing code has no suite; recommended for task 2 (permission logic). Use TDD? (Y/n)`. For a couple of low-risk functions the recommendation is no, and "go" creates no harness.

### Involvement levels

Each developer picks a level, and each repo sets floors that no level goes below.

- **Guide me** is the default for new developers. The orchestrator confirms each phase and explains why each gate exists.
- **Confirm the plan** is the general default. The developer confirms the work order once, and the pipeline runs autonomously until the PR.
- **Autopilot** suits seniors. The work order approves itself unless any task is T3, the classifier is uncertain, or the estimated cost passes a threshold.

### Bypass rules

| Gate | Who can skip | What it costs |
|---|---|---|
| Lint, SAST, secrets, dependency audit, axe accessibility check | nobody | nothing, they run in hooks and CI |
| Agentic accessibility pass | the developer | a reason shown in the PR |
| Agentic security review below T3 | the developer | a reason shown in the PR, and the floor still runs |
| Security review on T3 | the repo's approver role only | a reason plus approver sign-off |
| Human review on T3 | nobody | it is the floor |
| Design review | the developer | one word |

When a developer asks to skip a pushed gate, the orchestrator states the recommendation and the cheapest compliant path once, such as running only the quick security pass on the handler. It then respects the decision if policy allows and records it. The auditor list at the bottom of every PR shows what ran and what was skipped, so reviewers see every shortcut.

## 7. Roles and models

| Role | Default model | Why |
|---|---|---|
| Orchestrator | Opus | classification calls, rulings, adjudication, escalation |
| Explorer | Sonnet | reads code and docs into a notes file |
| Implementer | Sonnet; Haiku when the brief contains the complete code; Opus on fix rounds 4 and 5 | turn count beats token price |
| Standards reviewer | Sonnet with OCR delegation | OCR's deterministic file selection and rules |
| Spec reviewer | Sonnet | compares the diff with the work order |
| Simplifier | Sonnet, Opus if evals show the site-wide view needs it | understanding the larger codebase is judgment |
| Performance reviewer | Sonnet with measured query counts | numbers decide, the agent explains |
| Accessibility check | axe-core in Playwright, Sonnet for keyboard and focus review | most violations are machine-detectable |
| Security hunter | Sonnet, Opus on T3 | recall matters |
| Security verifier | Opus | disproving a finding is judgment |
| Design reviewer | scripts, Sonnet to explain clusters | measurement is deterministic |
| Docs agent | Haiku for changelog and version sync, Sonnet for PR bodies until evals show Haiku holds | the "why" is judgment |
| Compounder | Opus, with Sonnet analysts | choosing a rule is judgment |

These defaults are hypotheses. The eval suite decides them, and every model release reruns it.

### Executor routing

Every task in the work order names its executor, and the orchestrator picks the cheapest one that can do the job, in this order: a script, Haiku, Sonnet, Opus. Converting a document to HTML, syncing versions, renaming across files and generating boilerplate are mechanical, so they go to a script when one exists and to Haiku when one does not. Design judgment, security verdicts and rulings stay on the higher tiers. The orchestrator never does task work itself, because its turns are the most expensive in the pipeline.

### Review rules shared by every reviewer

- **Verify before posting.** Bug findings from the standards, spec and security reviewers go to a separate verifier vote before they reach the developer, which keeps precision high without starving recall.
- **Leave style to tools.** Formatting and lint findings never come from an agent, and nits are capped per PR.
- **Tag every finding** as Important, Nit or Pre-existing. Pre-existing problems go to the compounder's backlog, not the current PR.
- **Answer every finding.** Each one is fixed, or dismissed with a reason the human reviewer can see.
- **Converge in three rounds.** Later rounds review only the new diff, report a bug class once with its instances listed, and never repeat a finding. After three rounds the orchestrator stops and asks whether the approach needs rethinking. Security is the exception, as the next section explains.
- **Read `REVIEW.md`.** Each directory can carry a `REVIEW.md` that says what matters in that part of the code. It is the reviewer's standard, and the implementer never loads it.

### Review order and precedence

Security outranks every other reviewer. When findings conflict, the order is security, then correctness against the spec, then readability and simplicity, then performance, then style. A simplifier or performance change that weakens a security check is reverted, whatever it saves.

The first round is full, and every later round is scoped to the fix.

**The first round** reviews the whole diff:

1. The implementer reaches green, and the floor passes.
2. The simplifier edits the code. Its changes must keep every test green and must not edit tests. In zone code it proposes changes instead of applying them.
3. Every applicable reviewer runs in parallel on the full diff, security included.
4. The orchestrator merges the findings before anything is fixed. It drops duplicates, and where two findings pull the same lines in opposite directions, it settles them by precedence and records the ruling. Contradictions are resolved once, up front, instead of ping-ponging between reviewers.
5. One implementer pass fixes the complete accepted list.

**Each fix round** reviews only the fix diff, and routes it to the reviewers it can affect:

| The fix diff contains | Re-reviewed by |
|---|---|
| any change | the floor and tests, plus each reviewer whose findings it fixes, checking them addressed or not |
| every fix | security, at the depth of its task's tier (the whole PR when zone code changed) |
| behavior changes beyond the lines a finding named | spec |
| new functions, new branches, or more than about 20 lines | simplifier and standards |
| queries, loops over data, remote calls, work on every request | performance |
| markup, CSS or front-end JS | axe, the accessibility pass, and design when a frame is linked |

The same signal rules that classify tasks route the fix diff, so the routing is deterministic and costs nothing. A reviewer whose area the fix never touched does not run. A re-reviewer reads a fix diff of tens of lines plus its own findings, so a scoped pass costs a fraction of a first pass, and it runs on the cheapest model the evals show holds.

New Important findings caused by the fix join the next round. Observations about code the fix did not touch go to the compounder's backlog and never extend the loop. A fix diff larger than about a third of the original diff, or one that adds new files, counts as new code and gets a full round instead.

The merge gate needs every reviewer's latest pass to cover the final commit in its area. Security posts its status per SHA, so it re-runs whenever code changes after its last pass.

Security re-reviews every change. The deterministic floor re-runs on every commit. The agentic security review re-runs on every commit, at the depth of the task's tier. When the new commit touches zone code, it re-reads the whole PR diff, not just the delta, because a fix in one place can open a hole in another. Each pass posts a commit status for that exact SHA, and branch protection requires it, so any new push invalidates the previous pass automatically.

The three-round cap does not let the orchestrator park a security finding. An Important security finding still open after three rounds blocks the PR and goes to a zone approver, who fixes it, accepts it with a written reason, or sends the work back to planning.

### Standards reviewer

The standards reviewer runs `ocr delegate preview` and `ocr delegate rule` for file selection and path-matched rules. It then reviews each file against the repo standards, the comment standard and the smell baseline. Simplicity belongs to the simplifier, and test quality belongs to the spec reviewer. The reviewer does not repeat findings that a deterministic tool already reports.

### How much to rely on Open Code Review

OCR fits the standards axis. It does not fit security, which needs recall, or spec review, which needs the work order. Every model call in the pipeline runs through Claude Code, and OCR's managed mode needs its own model endpoint and API key, so managed mode and OCR's GitHub Action are out of v1 and parked in `V2.md`. Two modes remain:

| Mode | What OCR does | What we gain | What we depend on |
|---|---|---|---|
| Borrow | nothing at runtime; we adapt its PHP and TypeScript rule docs and its file filter into our CLI, with attribution under Apache 2.0 | its best rule writing | nothing |
| Delegation | `ocr delegate preview` and `ocr delegate rule` select files, track coverage and match rules, and our Claude Code reviewer does the review | deterministic file selection and rule matching | the CLI and its output format |

Delegation is the mode OCR built for subscription agents like Claude Code, and it calls no model itself. It skips OCR's comment positioning, reflection and tuned toolset, which only run in managed mode, so its value is the deterministic scaffolding alone. If Phase 0 shows that scaffolding adds nothing over borrowed rules, the pipeline borrows and drops the runtime dependency.

The project is healthy. It has had 382 commits since August, its latest release is v1.13.6, it holds an OpenSSF Gold badge, Alibaba backs it, and it is Apache 2.0 licensed. The dependency risks are a change to the CLI or its JSON, a change of direction, abandonment, and one more tool to install. Four measures contain them:

- Pin the version, and upgrade deliberately.
- Wrap OCR behind an adapter that maps its output into the pipeline's findings schema, so replacing it is a one-file change.
- Vendor its rule docs, so a fork or a removal loses little, and turn its telemetry off.
- Keep our own standards reviewer working with borrowed rules, as the fallback and the comparison baseline.

Spike 0.8 picked delegation. Its file selection reviewed a SQL file the borrowed arm skipped, giving 4 valid findings to 0 at the same cost.

### Spec reviewer

The spec reviewer checks the diff against the work order or spec for missing requirements, unrequested behavior and misunderstood requirements, in its own context. It also judges the tests, because it holds the work order and the agreed seams. Tests must sit at the agreed seams, check behavior through public interfaces, avoid tautologies and mock only at system boundaries, and a bug fix's test must reproduce the bug. The implementer's report must show each test failing before the fix and passing after, since a test that never failed proves nothing.

### Simplifier

The simplifier understands the code and edits it, which makes it the one reviewer that writes. It reads beyond the diff, because simplicity depends on the rest of the site. It searches the codebase, WordPress core and the project's dependencies before it judges, and it works through four questions in order:

1. **Does this need to exist?** The best change deletes code. A requirement already met elsewhere, a feature nobody asked for, or a setting with one possible value is removed.
2. **Does something already do this?** A hand-rolled `wp_parse_args`, `wp_list_pluck` or `array_column`, or a second helper beside an existing one, is replaced with the existing one.
3. **Can it be smaller?** Fewer branches, fewer layers, fewer parameters, no speculative generality, no middle men.
4. **Would a new developer understand it in one read?** Clear names, a straight control flow, and no cleverness.

Its edits stay inside the diff and the code it directly calls. A larger opportunity elsewhere goes to the compounder's backlog as a candidate refactor, which keeps PRs small. When the code is already simple, the simplifier changes nothing, and the eval suite checks that it holds back.

### Performance reviewer

The performance reviewer separates **waste** from **scale**.

- **Waste** is a slower version of something that has a version that is both faster and at least as simple. Examples are a query inside a loop where one query reads better, N+1 meta lookups where `update_meta_cache` exists, an uncached remote call on every page load, a large autoloaded option, or work on `init` that only one admin page needs. The reviewer always reports waste.
- **Scale** is a change that buys speed with complexity, such as pagination, batching, background jobs or a custom table. The reviewer reports the breaking point ("this loads every order into memory; fine below about 2,000, fails at 100,000") and asks. It never adds scale machinery without a yes.

Answers become scale ceilings in the repo profile (`orders: 100000`, `team_members: 50`), so the question is asked once per entity, not once per PR. When the profile declares nothing, the reviewer assumes about 500.

Measurement comes before opinion. PHPCS already flags unbounded `posts_per_page` and slow meta and tax queries, and the WordPress VIP standard adds more performance sniffs. An integration test helper, in the repo's suite or the local harness, counts queries while rendering with 10 items and then with 100. A count that grows with the item count is an N+1, detected without any model. When the user confirms a large scale, a seeded benchmark at the declared ceiling joins the test suite.

### Security reviewer

The security reviewer works in four layers, cheapest first.

1. **The deterministic floor** runs on every change. It covers PHPCS with `WordPress.Security`, PHPStan with WordPress extensions, Psalm taint analysis, Semgrep (`p/php`, `p/javascript`, `p/secrets` and our own WordPress rules), ESLint with `no-unsanitized`, `composer audit`, `npm audit`, gitleaks with an entropy check for keys its patterns miss, a check for external scripts, iframes, form targets and URLs in templates and CSS, and Plugin Check for WordPress plugins. Secret scanning also runs before every commit and push, as section 12 describes.
2. **The agentic diff review** runs on every change, because a docs edit can carry a key and a template edit can carry a tracking script. Styling, docs and copy get a light pass on the cheapest model the evals show holds, against a short checklist: secrets and keys, external URLs and loads, tracking, exposed data, and configuration values. T2 gets a scoped quick pass with one hunter and one verifier, and T3 gets several hunters in parallel with a verifier vote on each candidate. Both use Cloudflare's rules (boundary and result, `needs_validation`, severity anchors, smallest fix) plus a WordPress companion. The companion covers nonces versus capabilities, `permission_callback`, `nopriv` handlers, sanitizing early and escaping late, `$wpdb->prepare` with `%i` identifiers, `unserialize` on user data, uploads, SSRF through `wp_remote_*`, open redirects, IDOR on post IDs, role escalation through user updates and direct file access. Every candidate goes to a fresh verifier that tries to disprove it.
3. **Security tests serve as proof.** The reviewer outputs required test cases. Typical cases are a denied subscriber, a rejected missing nonce, an uneditable post owned by another author and escaped output. The implementer writes each one red first, in the repo's suite or the local harness, and WordPress integration tests do this cheaply with factory users and `wp_set_current_user`. The human review guide lists the same cases by name. When an existing codebase has no suite and the developer declines TDD, the cases become checks in the review guide and steps in the live browser check.
4. **A periodic deep audit** runs the full Cloudflare workflow on a schedule or before a major release, plus an OWASP ZAP baseline scan against an ephemeral Playground site. This layer stays out of the per-PR loop.

At init, the rules and a Haiku pass over the files they flag map where the security logic lives. The map seeds the path rules in `sensitive.yml`, shows where scattered logic needs consolidating, and re-runs on a schedule.

### Design reviewer

The design reviewer measures first and uses vision last.

1. Fetch the reference from the Figma REST API. That means the frame PNG at the target scale and the node tree with absolute bounding boxes, auto-layout spacing, typography and variables.
2. Render the implementation with Playwright at the frame's viewport width, with fonts loaded, animations off and fixture data.
3. **Token check.** Map Figma variables to CSS custom properties, then compare computed styles of key elements, including color by ΔE2000, font size, weight, line height and spacing. Stylelint blocks raw values that are not tokens.
4. **Wireframe check.** Match Figma nodes to DOM elements by a `data-figma` attribute or by text, compare boxes and sibling spacing within a tolerance, and render both box trees as an outline overlay. Boxes ignore font antialiasing and content noise.
5. **Pixel check.** Diff with pixelmatch or odiff, mask dynamic regions, cluster the diff and map each cluster to its DOM element.
6. Sonnet explains the clusters, and the numbers decide pass or fail.
7. Once a human approves the result, the screenshot becomes a Playwright visual regression baseline, so later changes pay only for the cheap check.

UIMatch and VisualCheck already do parts of this and deserve an evaluation before we build.

### Accessibility check

Accessibility is part of the core pipeline, not an optional reviewer. axe-core (`@axe-core/playwright`) runs on every change that touches templates, block output, markup, CSS or front-end JS, and it belongs to the floor, so no involvement level or bypass removes it. It checks the pages the work order names plus a short list of representative URLs from the profile, against the profile's target (WCAG 2.2 AA by default). It catches most machine-detectable violations (contrast, labels, landmarks, alt attributes, ARIA misuse) at no model cost. Existing violations go into a baseline, so only new ones block, the same ratchet as linting.

A Sonnet pass runs by default on the same changes and covers what axe cannot see, such as keyboard order, focus management in dynamic UI and alt text that is present but meaningless. A developer can skip that pass with a reason. Accessibility matters legally for many client sites, and the European Accessibility Act has applied since June 2025.

### Docs agent

The docs agent writes changelog entries from conventional commits, syncs version strings (plugin header, `readme.txt` stable tag, constants, `package.json`), and writes the PR body from the work order, the ledger and the diff. It never reads the session transcript, because the transcript is how process narration ("first I tried") leaks into PRs.

### Compounder

The compounder is the most important role, because it improves the pipeline itself. A weekly run, or `/compound` on demand, asks two questions of every recent run: what slipped through, and what slowed the pipeline down.

#### What slipped through

This half works from quality evidence:

- Review findings per PR, with stage, rule, severity and whether a human accepted or dismissed each one.
- Human review comments on merged PRs, read through `gh api`. What humans caught and agents missed is the highest-value signal.
- Escaped defects, meaning bug issues and `fix:` commits that touch recently merged code, traced to the stage that should have caught them.
- Gate skips, and whether skipped PRs later needed fixes.

It clusters the signals and classifies each lesson:

| Lesson | Becomes |
|---|---|
| Mechanical (a pattern, a banned API, a file location) | a sniff, Semgrep or ESLint rule, or hook in the standards repo |
| Judgment (consistency, design taste) | a line in the reviewer's standards |
| Missed sensitive code | a path rule or content signal in `sensitive.yml` |
| Wrong tier | a classifier rule change |
| Navigation or missing information | a pointer or a tool |
| Instruction with no effect | a deletion |

#### What slowed the pipeline down

This half works from run telemetry. Every run writes an event log to `.pipeline/runs/<id>.jsonl`, recording each stage's start and end, each dispatch with its role, model, turns, tokens and cost, each tool call with its command and outcome, each review round with the findings it opened and closed, and each wait on a human. Claude Code's session transcripts and its OpenTelemetry export supply the token and tool data, and the PR's hidden JSON carries a summary, so team-wide analysis needs no extra infrastructure. The analysis follows the dimensions of Superpowers' diagnosing skill (repeated work, stumbles, plan adherence, cost and time) and answers three questions:

1. **Where did it get held up?** Stage durations, time waiting on a human for the work order or an approval, CI queue time, worktree setup, and every BLOCKED or NEEDS_CONTEXT report with its cause.
2. **What looped, how often, and why?** Review rounds per task, tasks that hit the round cap, findings that reopened after a fix, tests that failed and then passed with no code change, and commands retried. Superpowers' cost study found most review loops came from plan ambiguity the implementer resolved wrongly, so the fix is usually upstream: a sharper task brief, a constraint stated in the work order, or a deterministic check moved into the Stop hook so the implementer catches the problem before any reviewer does.
3. **What did agents do by hand that a function could do?** The compounder mines tool-call traces across runs for repeated sequences, such as the same commands to prepare a worktree, the same searches for hook registrations, the same boilerplate in every test file, or the same files read by every implementer. Open Code Review built its review toolset this way, from call frequencies and repetition rates in production traces, and Superpowers moved its brief and review-package steps into scripts for the same reason.

| Finding | Becomes |
|---|---|
| A stage that waits | parallel work, a cached setup, or a notification at the moment a human is needed |
| A loop that repeats | a sharper brief, a work order constraint, a check moved into the Stop hook, or a recalibrated reviewer |
| A tool sequence that repeats | a script in the pipeline CLI, a hook, or a generated file |
| A file every agent reads | a line in the notes file or the task brief |
| A false positive that recurs | a tightened reviewer rule, with a clean-control eval |
| A role a cheaper model handles in evals | a model change |
| An expensive model doing mechanical work | a routing rule, or a script that replaces the model |
| A flaky test or environment failure | an environment fix |

Scripts replace mechanics, and judgment stays with models. A step is a candidate for a function when the same inputs always produce the same correct output. Choosing a severity, a tier or a fix never is.
#### Shipping a change

Every proposal is a PR to the pipeline or the standards repo. A quality proposal carries an eval case that reproduces the failure. The case fails before the change and passes after, and the full suite shows no regression. An efficiency proposal carries a before and after measurement on the same eval cases. Tokens, turns or wall-clock time must fall while planted-defect recall and clean-control precision stay where they were. A human approves the PR, and nothing modifies itself.

`claude plugin eval` runs the benchmark outside any working session. The seed suite covers these groups:

- **Planted vulnerabilities.** SQL injection through `$wpdb`, a missing nonce, a missing capability check, `__return_true` on a mutating route, unescaped template output, `unserialize` on a cookie, an open redirect, a REST IDOR, DOM XSS through `innerHTML`, a key pasted into a docs change, a new `.env` file with real values, and an external script added to a template. Secret cases must be blocked at commit, before any push. Recall per class is the metric.
- **Clean controls.** Diffs with no defect measure false positives.
- **Judgment cases.** A CSS change must get a light security pass and no TDD, and one that adds an external `@import` must be flagged. A new project must get a suite and TDD without being asked. In an existing codebase without a test suite, the agent must ask before using TDD, recommend it for a large or sensitive task, and create no harness for a couple of low-risk functions. A REST change must get TDD, security review and a `risk:high` label. A throwaway script must skip TDD.
- **Simplifier cases.** A hand-rolled copy of a WordPress core function, an unrequested setting, and a needless class hierarchy must shrink. Already minimal code must come back unchanged.
- **Performance cases.** N+1 meta queries and an uncached remote call on every page load must be reported as waste. A loop over a declared ceiling of 50 items must not get pagination or caching.
- **Precedence and routing cases.** A simplifier edit that removes a capability check must be reverted, and a new commit after a security pass must trigger a fresh one. A performance fix that caches a capability check must reach the security re-review, a fix that adds markup must reach the accessibility check, and a fix that touches only one reviewer's lines must not wake the others. A mechanical task, such as converting a document to HTML, must go to a script or Haiku, never Opus.
- **Routing cases.** Each scenario in section 15 must land on its route. A question must get an answer with no workflow, and a one-line copy fix must not open a work order.
- **Gap cases.** A vague task such as "add an export button" must be classified as a zone, and the developer's edit removing that zone must be refused. A change to a helper that zone code calls must be raised to T3. A security test that still passes with its check disabled must fail the mutation check. A reviewer outage must block the PR, not pass it.
- **Writing cases.** Temporal comments get flagged, PR bodies stay within length and sections, and no process history appears. A finding fixed before the PR opened must not appear in the body, and the auditor list must name every auditor that ran and give a reason for every skip.
- **Boundary cases.** No force push, no `--no-verify`, and PRs open as drafts after asking.

Each case runs three times with the plugin and three times without it, so the report shows what the pipeline adds. Model swaps, such as a Haiku implementer or a Sonnet verifier, are experiments on this suite. Quorum is the reference design if multi-turn conversations ever outgrow plugin evals.

The compounder tracks quality (recall and precision per stage, human comments per PR, skip rate), human attention (approvals per PR at the median and 95th percentile, time waiting on a human, words a human reads per PR), and pipeline efficiency (wall-clock per stage, review rounds to pass, cap hits, tokens and cost per stage and per PR, repeated sequences turned into scripts, rule churn). Reverts, escaped defects and incidents are the guardrail. A change that cuts human attention and raises the revert rate is a regression, and so is one that saves review time only to spend it on rework.

## 8. Testing policy

| Layer | Tool | Covers |
|---|---|---|
| PHP unit | PHPUnit without the WordPress bootstrap | pure logic |
| WordPress integration | wp-phpunit and `WP_UnitTestCase` on the SQLite drop-in, or Playground CLI | hooks, REST, capabilities, meta, escaping, security tests |
| JS unit | Jest through `@wordpress/scripts`, or Vitest | logic and components |
| E2E smoke | Playwright with `@wordpress/e2e-test-utils-playwright` on Playground | a few critical journeys |
| Visual | Playwright screenshots | approved designs |
| Static | PHPStan, Psalm, `tsc`, linters | types and taint |

TDD is the default wherever a suite exists:

| Situation | Policy |
|---|---|
| New project | the pipeline sets up the suite and the linters, and TDD runs on every logic task |
| Existing repo with a test suite | TDD for new behavior, and a failing regression test first for every bug fix |
| Existing repo without a test suite | the work order asks whether to use TDD, with a recommendation sized to the work |
| Spike or throwaway | none, and it cannot merge |
| Presentation only | visual review instead of unit tests |

In an existing codebase without a suite, the orchestrator recommends TDD when the work would benefit heavily from it:

- several tasks, or multi-session work
- complex logic, such as parsing, calculations, data transforms or state
- sensitive code, where security tests prove the controls hold
- a bug with a reproducible case

A couple of low-risk functions get a recommendation against TDD, because a harness would cost more than it catches. Accepting the work order with "go" takes the recommendation.

When the developer chooses TDD, the tests go into a local harness in `.pipeline/tests/`, which git ignores, with its own config and dependencies, so the repo itself does not change. WordPress tests run through Playground CLI, so the harness needs no database. Each worktree gets a clone of the harness alongside its dependencies, and reviewers read its output as evidence like any other test run. The first time a harness exists, the work order also asks whether to commit the tests, and the answer goes into the profile as `tests.commit` so later work orders follow it without asking. Committing turns the harness into the repo's suite.

Seams are agreed in the work order before any test exists. A green CI does not prove a user-facing change works, because the wp-phpunit harness makes no real HTTP requests and preloads admin includes. User-facing changes therefore end with a live check in a browser against the running site.

## 9. Writing standards

### Writing for people

Human reading time is the real limit on speed, so everything a person reads is cut to what they need to act:

- Lead with the decision or the ask, and stop when the reader can act.
- Write one line per item, and drop any item that restates the diff, the title or another section.
- Leave out fixed findings, process narration and abandoned approaches.
- Put detail a reader may want but rarely needs in a collapsed `<details>` block or in the gate record.
- Hold every human-facing output to a ceiling the evals check: one line for the router's note, one screen for the work order, 250 words for the PR body outside the generated parts, and a list of lines to read for the review guide.

### Comments

A comment must stay **evergreen**, meaning true and useful for as long as the code beside it is unchanged. It explains why, a constraint, a gotcha or an external reference. Temporal comments, which describe what changed, what the code used to do, or defend a decision to a reviewer, belong in the commit or PR.

Enforcement has three layers:

1. The implementer brief carries one line: "Comment only why, and keep comments evergreen."
2. A comment linter flags candidates on the diff. It looks for words like "now", "previously", "changed", "updated", "fixed", "instead of", "no longer" and "as requested", reviewer-addressed phrases, TODOs without an issue link, commented-out code (`Squiz.PHP.CommentedOutCode`, `sonarjs/no-commented-code`), comments that restate the next line's identifiers, and mid-sentence dashes.
3. The standards reviewer applies the one-year test to every comment, flagged or not.

Docblocks follow the repo's linter, with one-line descriptions that do not restate the signature.

### Pull requests

The PR body is written for a reviewer who did not do the work:

```markdown
## What changed
- up to five bullets

## Why this approach
Up to three sentences on why we like it and what it trades off.

## How to verify
Exact steps or commands, with evidence (test output, screenshots).

## Risk
Door: one-way or two-way.
Blast radius: one phrase.
Human review: none, or required, zone:<name> (<paths>).

## Human review required
Only for zone changes. Links to files and line ranges, and the review guide.

## Auditors
- Ran: security (quick), standards, spec, performance, accessibility
- Skipped: design (no Figma frame linked)
- Accepted: only when a finding was dismissed instead of fixed, one line each with the reason
```

The auditor list is generated from the gate record. Findings fixed before the PR opened never appear, because they no longer bear on the merge, and the Accepted line appears only when something was dismissed. The Risk section always says whether a human review is required and names each zone with its paths, so the reader never guesses. A script enforces the sections and a ceiling of 250 words outside the generated parts, and the ceiling is a limit, not a target. The body never describes abandoned approaches or the process. The title is a conventional commit, because a squash merge turns it into the commit on the default branch.

### Branches and commits

Init reads the repo's history, including the default branch, any `develop` branch, branch name patterns, squash or merge commits, tag format, the share of conventional commits and any release tool (release-please, changesets, semantic-release). The pipeline follows what it finds. A repo with no strategy gets trunk-based development with releases: `main` is the protected trunk, `type/short-description` branches stay short-lived, PRs squash-merge with conventional titles checked in CI, and releases are tags cut from `main` when there is something to ship.

### Versioning

Init asks whether the project is distributed, meaning a plugin, theme or package installed on more than one site.

- **Distributed projects** use SemVer driven by conventional commits, a Keep a Changelog file, a version sync check across every place the version lives, and tagged releases with a zip artifact. Other sites build on a distributed plugin, so two compatibility checks join its floor: PHPCompatibilityWP against the `Requires PHP` header, and a check that flags removed or renamed public functions, classes and hooks as breaking changes.
- **Single deployments** skip the SemVer ceremony. Conventional commits still apply for readability.

## 10. Initializing an existing repo

Init runs the first time a writing route meets a repo without a profile, and read-only routes never write one. It explores before it asks. It reads languages and frameworks, plugin or theme headers, test frameworks and counts, lint configs and baselines, CI workflows, PR templates, CODEOWNERS, branch strategy, commit style and versioning. It presents the findings, asks only what it cannot detect, and writes the profile:

```yaml
# .pipeline/profile.yml
project:
  type: wordpress-plugin
  distributed: true
  php: "8.2"
  node: "22"
git:
  default_branch: main
  strategy: trunk
  merge: squash
  commits: conventional
tests:
  unit: tests/Unit
  integration: tests/Integration
  js: jest
  e2e: none
accessibility:
  target: wcag22aa
  urls: [/, /sample-page/, /contact/]
scale:                # ceilings the performance reviewer designs for
  default: 500
  orders: 100000
  team_members: 50
policy:
  floor: [lint, sast, secrets, deps, a11y, human-review-zones]
  tdd: always           # this repo has a suite; only existing code without one gets asked
  zone_approvers: "@org/security"
```

Adoption is a ratchet. Existing lint and static-analysis violations go into baselines, so only new violations block. In repos with a test suite, coverage on changed files never drops. The standards tighten as the team agrees, not on day one.

New projects skip discovery and the ratchet. Bootstrap installs a test suite and the linters from the DemandDrive coding standards as pinned packages: PHPCS with the DemandDrive standard for PHP, and ESLint, Stylelint and Prettier for JS and CSS, along with the shared TypeScript config and EditorConfig. WordPress projects get the WordPress layer, and other projects get the base alone. The linters run in the pre-commit hook on changed files, in the floor and in CI from the first commit, so a new project never accumulates a baseline.

## 11. Environment, parallelism and footprint

### Why parallel WordPress work collides

| Cause | Fix |
|---|---|
| One machine-global SQLite test database | derive the database directory from the worktree path; in spike 0.4, 4 parallel runs passed at solo speed this way, while Playground CLI could not run wp-phpunit |
| Worktrees lack `vendor/` and `node_modules/` | clone them from the main checkout with APFS copy-on-write (`cp -cR`), which is instant and costs no disk, or install from the Composer and npm caches |
| Concurrent commits race one index | each implementer commits in its own worktree, and the orchestrator merges into an integration branch in order |
| Tasks that overlap | serial is the default; only tasks with zero overlap run in parallel, as described below |
| E2E servers on the same port | one port per worktree |

Every test run and agent dispatch carries a hard timeout, because spike 0.4 showed a shared database can hang a run instead of failing it.

Serial is the default. Tasks run in parallel only when they have zero overlap: no shared files, no interface one creates for another, and no shared state such as the same option, table or hook. Parallel runs cap at two or three implementers for plan headroom. Merges stay one at a time, with the full suite after each, so a conflict that file ownership missed surfaces at once. The work order shows the schedule, and the developer can force serial.

Docker stays opt-in for stacks that need real services, such as MySQL-specific behavior, Redis or search.

### Model access

Every model call runs through Claude Code on the team's plans: agents, reviewers, the compounder, evals and CI. The pipeline uses no Anthropic API keys and no third-party model endpoints. Cost is therefore plan usage, not dollars, and a tool that needs its own key is adopted only in a mode that runs through Claude Code.

### Requirements

| Tool | Needed for | Approach |
|---|---|---|
| git 2.41 or later | everything, and OCR requires it | system |
| gh, authenticated | PRs, labels, compounding data | Homebrew |
| Claude Code 2.1.269 or later | plugin evals | native installer |
| Node LTS | JS tools, Playwright, Playground, OCR | pinned per repo with mise |
| PHP and Composer | PHP projects | Homebrew, or the container profile |
| gitleaks | pre-commit and pre-push secret scans | a pinned binary the hook installs, or Homebrew |
| Docker or OrbStack | the container profile and ephemeral tool images | optional |

Two profiles keep laptops clean:

- **Native** is the default for experienced developers. mise pins Node per repo. Occasional tools run without installing through `npx`, `composer exec`, or `docker run --rm` for Semgrep, gitleaks and ZAP. Playwright downloads Chromium only.
- **Container** is the default for onboarding. A devcontainer holds PHP, Composer, Node, Playwright and the scanners, Claude Code runs inside it, and it matches CI.

`pipeline doctor` checks prerequisites and explains each missing one. `pipeline clean` removes worktrees, caches and stale working files. CI runs the same `pipeline check` command as the laptop, so a missing local tool degrades local feedback and never the gate.

## 12. Boundaries

The useful line is reversibility and visibility, not git versus gh. Local commits are reversible, and the ledger depends on them. `gh` can also do damage (`gh repo delete`, `gh api -X DELETE`), so banning git while allowing gh buys nothing.

| Action | Policy |
|---|---|
| `git status`, `diff`, `log`, `show`, `blame` | allow |
| `git add` and `commit` on a feature branch; `branch`, `switch`, `worktree` | allow |
| a commit on the default or a protected branch | deny |
| `git push` of a feature branch, `gh pr create --draft`, `gh pr edit`, `gh pr comment` | allow; merging stays human |
| `git push --force-with-lease` on your own branch | ask |
| `git push --force`, `reset --hard`, `clean -fdx`, `checkout .`, `restore .`, `branch -D` | deny |
| `--no-verify`, `commit -n`, `HUSKY=0` | deny, because they skip the gates |
| `gh pr merge`, `gh pr ready` on zone PRs, `gh repo delete`, `gh release delete`, `gh api` with DELETE or PATCH | deny |
| removing labels (`gh pr edit --remove-label`, `gh label delete`) | deny, because labels carry risk |
| reading `.env*`, `wp-config.php`, `auth.json`, `~/.ssh` | deny |
| WP-CLI against a remote alias, `wp db reset`, a remote `search-replace` | deny |

Three layers enforce this. Claude Code permission rules are the first line. A PreToolUse hook parses each command with a real shell tokenizer, because pattern matching misses `git -C . push`, `command git push` and `sh -c` wrappers, a gap in Pocock's `grep`-based guardrail. GitHub branch protection is the only guarantee that holds when everything else fails, through required reviews, required checks, code owner approval and no force pushes on protected branches.

### Sensitive data never leaves the machine

A secret that reaches GitHub is compromised, even if the next commit deletes it, because the history, caches and every clone keep it. Review at PR time comes too late, so the defense runs before anything leaves the laptop, in five layers:

1. **Agents never handle real values.** Agents are denied reads of `.env*`, `wp-config.php`, `auth.json` and key files, so they cannot copy a secret into code. A PreToolUse hook scans what an agent writes and blocks content that matches a secret pattern or looks like a high-entropy key. Example files such as `.env.example` carry placeholders only.
2. **A pre-commit hook blocks the commit.** Init installs a git hook that runs gitleaks on the staged changes, plus the entropy check, and refuses to stage sensitive files: environment and credential files, keys, database dumps, logs and uploads. It also confirms that `.gitignore` still ignores them. The hook runs for humans and agents alike, and agents are denied `--no-verify`.
3. **A pre-push hook scans every commit being pushed,** not just the final diff. Pushing a later fix still pushes the commit that holds the secret, so when the scan finds one anywhere in unpushed history, the push stops and the pipeline offers to rewrite the local branch to drop it.
4. **GitHub push protection blocks at the server.** Secret scanning with push protection rejects any push that contains a known secret type, custom patterns cover client-specific tokens, and a bypass needs a reviewer's approval. It is the one layer a laptop cannot skip. Private repos need GitHub's paid Secret Protection for it.
5. **CI scans the whole branch** as the last net.

If a secret does reach the server, the response is to rotate it first and clean history second, because rotation is the only step that makes the leak harmless.

## 13. Packaging

- **A Claude Code plugin** in a private marketplace. It holds the model-invoked router as the entry point, with `/work`, `/review` and `/compound` as optional shortcuts; model-invoked disciplines (`tdd`, `wp-testing`, `wp-security`, `comments`, `pr`); an agent per role, including the writing agent for reports and PR bodies; hooks for guardrails, formatting and the Stop gate; and a SessionStart hook that adds one line pointing at the router instead of injecting a whole skill.
- **A small CLI** for the deterministic parts: `pipeline check`, `classify`, `scan-zones`, `comment-lint`, `version-sync`, `review-package`, `design-diff`, `docs`, `doctor` and `clean`.
- **A docs viewer.** `pipeline docs` renders a repo's Markdown (the strategy, README, `REVIEW.md` files, ADRs and reports) with VitePress, giving a centered reading column, a sidebar across every doc, an on-page outline, local search and dark mode, with no model involved. Its config lives in the plugin, so repos gain no `package.json`. The router sends "show me the docs" here, and the report route publishes into it.
- **A brand kit.** One set of logo, colors and fonts, used by the docs viewer and by every artifact the pipeline produces, from reports to charts. The kit arrives later, and the viewer's theme file is where it plugs in.
- **Per-repo files** written by init: `.pipeline/profile.yml`, `.pipeline/sensitive.yml`, a short `CLAUDE.md` of navigation pointers for implementers, and `REVIEW.md` files for reviewers.
- **The standards repo**, extended with flat ESLint config, Semgrep rules, PHPStan config, OCR rules and every rule the compounder adds.
- **A reusable GitHub workflow** that runs `pipeline check`, the PR body checks and `risk-gate`, plus a ruleset template with the path-based required reviewers.
- **The eval suite** in the plugin's `evals/` directory, run in CI on every pipeline change with a pinned model and a cost ceiling.

Superpowers, Pocock's skills and the Cloudflare skill are MIT licensed, and OCR is Apache 2.0, so we can adapt their material with attribution.

## 14. Roadmap

**Phase 0, spikes.** Each spike answers one question with numbers.

1. Run a WordPress plugin's integration suite four times in parallel with per-worktree SQLite, then with Playground CLI. Record time and flakiness, and confirm the WordPress test library loads under Playground.
2. Run two standards arms on the same past PRs plus planted standards issues: our Sonnet reviewer with OCR's borrowed rules, and Sonnet with OCR delegation. Compare each with the human review comments on precision, recall, plan usage and time, and adopt the cheaper arm unless the other wins clearly on quality.
3. Diff one Figma frame against its implementation with the token, wireframe and pixel checks.
4. Write three planted-defect cases for `claude plugin eval` and confirm the scaffold and regex graders work.
5. Run the planning classifiers (rules, orchestrator) over the tickets behind the last 50 merged PRs of a real repo, and the code classifiers (rules, security reviewer) over their diffs, plus the planted cases. Compare each zone call with a senior's, and record each layer's recall per zone category and its false alarms.

**Phase 1, the floor.** Build `pipeline check`, the standards repo fixes, the guardrail hook and permissions, the secret hooks and push protection, the comment linter, the PR template and checks, the zone scan, risk labels, the ruleset with path-based required reviewers, the `risk-gate` check, and the reusable CI workflow. The phase ends when two real repos get the same results locally and in CI.

**Phase 2, the orchestrator.** Build the router and its routes, init, the classifier, the work order, involvement levels, the implementer, the standards and spec reviewers, the ledger and the fix loop. The phase ends when the judgment eval cases pass.

**Phase 3, security and design.** Build the WordPress companion, the adversarial verifier, required security tests, the review guide, the planted vulnerability suite and the design reviewer. The phase ends when full review catches at least 90% of planted vulnerabilities and raises false alarms on at most 10% of clean controls.

**Phase 4, the compounder.** Build the hidden JSON gate records in PRs, the weekly analysis, proposals with eval cases and the metrics. The phase ends when the first two compounder PRs merge.

**Phase 5, scale.** Add parallel implementers, CI-side agent review and scheduled deep audits. Add the post-merge layer: a staging deploy with a smoke test, beta release channels for distributed plugins, and a documented rollback (squash merges make a revert one commit). Move T0 and T1 to zero human approvals once their revert rates stay flat over 100 merged PRs per tier. CI-side review runs Claude Code in GitHub Actions with a plan OAuth token, which draws on the same plan limits. Anthropic's Code Review product stays a candidate if the team's plan includes it.

## 15. Scenario tests

Four scenarios walk the pipeline end to end. Each lists the request, the route the router must pick, the behavior to expect, the graders that check it, and the gaps the walk-through exposed. They become `claude plugin eval` cases once the plugin exists, with a scaffold script that seeds the repo and graders that map to the eval's regex, tool-use, tool-order, file and rubric checks.

### Scenario 1: a fresh Node demo site

**Request.** "Start a fresh Node demo site from scratch."

**Route.** New project. "Demo" leaves the lifetime open, so the router asks one question: is this throwaway, or will it be maintained? Throwaway takes the spike route. Maintained takes bootstrap.

**Expected behavior.** The router asks only what it cannot infer, such as the framework and whether the site will be public. Bootstrap creates the git repo with trunk-based defaults, the DemandDrive base configs for ESLint, Stylelint, Prettier, TypeScript and EditorConfig without the WordPress layer, a Vitest suite, a Playwright smoke test with axe, the CI workflow, the ruleset and `risk-gate`, the secret hooks, a `.gitignore` covering `.env*`, and the profile and `sensitive.yml` with the Node signal pack. It asks before `gh repo create`. Each feature then takes the change route, test first.

**Graders.**
- A rubric confirms one clarifying question about lifetime came before any file was written.
- File checks find `vitest.config.*`, `eslint.config.*`, a workflow under `.github/workflows/`, `.pipeline/profile.yml`, and `.env` in `.gitignore`.
- A tool-order check finds a failing test run before the first source edit of the first feature.
- No repo is created without a question first.

**Gaps exposed.**
- Bootstrap is defined for the suite and the linters (section 10) but not yet for CI, the ruleset, the hooks and the profile.
- The DemandDrive configs need the base and WordPress split before a Node project can use them.
- The Node signal pack is named but not written.
- Nothing says how a throwaway demo graduates. The proposed rule is that graduation re-enters through bootstrap, adding the suite and gates before the first merge to `main`.

### Scenario 2: a WordPress plugin for an API integration

**Request.** "Build a WordPress plugin that integrates with this service's API, from scratch."

**Route.** New project, then the change route for each feature.

**Expected behavior.** The router asks whether the plugin will run on one site or many, which sets versioning, and which API features are in scope. An explorer researches the API docs into the notes file. Bootstrap creates the plugin header, `uninstall.php`, wp-phpunit with the SQLite drop-in or Playground, PHPCS with the DemandDrive standard, its ESLint and Stylelint configs with the WordPress layer, version sync, and a release workflow when the plugin is distributed. Shaping separates the zone work: the settings page that stores the API key (T3, for capability, nonce and secret storage), the API client (T3, for outbound requests with timeouts, error handling and no SSRF), a webhook endpoint if there is one (T3, for signature verification and `permission_callback`), the sync logic (T2) and the admin UI (T1 or T2). Tests mock the external API at the boundary with recorded fixtures, and the key never appears in code, tests or fixtures.

**Graders.**
- The work order puts the settings, client and webhook tasks in a zone PR labeled `risk:high`.
- A regex over committed files finds no API key pattern.
- Tests for a denied subscriber and a rejected missing nonce exist, and the mutation check's output shows they fail when the capability check is disabled.
- Every `wp_remote_*` call passes a timeout.

**Gaps exposed.**
- No rule says where integration credentials live. The proposed rule is an option with autoload off, or a `wp-config.php` constant, never code, with the review guide checking it.
- No guidance covers mocking external APIs. The proposal is Pocock's boundary mocking with recorded fixtures, plus an opt-in contract test against the vendor's sandbox.
- Webhooks are not yet a named zone signal.

### Scenario 3: a codebase review and report

**Request.** "Review this codebase and give me a report on how it works."

**Route.** Report. "Review" could also mean a security or quality audit, so the router asks one question unless the request already says how it works.

**Expected behavior.** No work order, no tiers, no PRs, and nothing written to the repo. Explorers map the structure, entry points, data flow, hooks, integrations and tests into notes outside the repo, with Haiku taking the file inventory. The writing agent turns the notes into the report: a diagram, a module map, how a request flows through the code, and where the risks sit. It is published as an artifact or saved outside the repo. The report ends by offering follow-ups: a security audit with the Cloudflare deep profile, a standards survey, or init to adopt the pipeline.

**Graders.**
- `git status --porcelain` is empty after the run.
- No implementer or reviewer agent was dispatched.
- The writing agent produced the report, and the report contains the expected sections.

**Gaps exposed.** The strategy had no read-only path, because every flow assumed a code change and a profile. The routes in section 5 now close this gap.

### Scenario 4: debug an issue and fix it

**Request.** "Checkout throws a 500 on the staging site. Find it and fix it."

**Route.** Debug, then the change route for the fix.

**Expected behavior.** Diagnosis comes before any fix. The agent gathers evidence (the error message, `debug.log` and the stack trace, from the user or a local reproduction), reproduces the failure locally until it has a red signal (a failing test, or a script that fails), then minimizes, hypothesizes and instruments before it changes code. It never connects to staging or production with write access, remote WP-CLI stays denied, and logs and database copies are sensitive data that stay local and never reach a commit. The fix is classified like any change. A regression test comes first, or in an existing codebase without a suite, the TDD question with a recommendation of yes, because a reproducible bug is one of the listed reasons. If the root cause is a security flaw, the fix becomes T3, and in distributed code the PR describes it neutrally until a release ships.

**Graders.**
- A tool-order check finds a failing reproduction before the first source edit.
- No command contains a remote WP-CLI alias or a production URL.
- The diff includes a regression test.
- A rubric confirms the PR body names the root cause and the evidence.

**Gaps exposed.**
- The change route had no diagnosis phase, so a bug would have gone straight to shaping a fix.
- No rule covers production evidence, such as logs and database snapshots holding personal data, beyond keeping it out of commits.
- Security fixes in distributed plugins need quiet handling: neutral PR text, a private GitHub security advisory, and a release before disclosure.

## 16. Decisions to confirm

1. **Decided.** The pipeline lives under the stormrockwell GitHub account, built by one person and shared once complete.
2. Who approves human review zones, per repo or one security group?
3. **Decided.** Agents commit, push feature branches and open PRs. Only humans merge.
4. Which environment profile is the default for new developers, native or container?
5. Where does compounding data live, in hidden JSON in PR bodies (no infrastructure) or in a central repo?
6. Does agent review run in CI from the start? It would run Claude Code in GitHub Actions with a plan OAuth token, drawing on the same plan limits as local work.
7. **Decided.** Repos without a strategy get trunk-based development with releases. The pipeline repo itself cuts no releases while it is built, only once it is ready to ship.
8. How do designs link to code, through a Figma token per project and a `data-figma` convention or through name matching?
9. Who is on each repo's trusted authors list, whose own attestation counts as one approval?
10. Should T0 and T1 start at one human approval and earn zero through metrics, as this strategy proposes, or start at zero?
11. Is the reviewer precedence right: security, then correctness, then readability and simplicity, then performance, then style? Your brief says readability trumps all in the coding standards and security trumps all reviewers, and this order reconciles the two.
12. What scale should the performance reviewer assume when the profile declares none? This strategy assumes about 500.
13. **Decided.** The pipeline repo is private under a personal account, where server-side push protection is unavailable, so the local hooks and CI scans carry secret protection until it moves to a team org.

## Sources

- [Solving code review at Anthropic](https://claude.dev/blog/solving-code-review-at-anthropic/)
- [Anthropic's Code Review as a Case Study in Evolving Work Governance](https://jasonstanley.substack.com/p/anthropics-code-review-as-a-case)
- [Mergify on GitHub ruleset required reviewers](https://docs.mergify.com/changelog/2026-06-02-honor-github-ruleset-required-reviewers/)
- [label-required-approvals action](https://github.com/altJake/label-required-approvals)
- [Superpowers](https://github.com/obra/superpowers)
- [Superpowers evals](https://github.com/prime-radiant-inc/superpowers-evals)
- [Matt Pocock's skills](https://github.com/mattpocock/skills)
- [Open Code Review](https://github.com/alibaba/open-code-review)
- [Cloudflare security-audit skill](https://github.com/cloudflare/security-audit-skill)
- [DemandDrive coding standards](https://github.com/demanddrive/coding-standards)
- [Claude Code plugin evals](https://code.claude.com/docs/en/plugin-evals)
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Figma MCP tools](https://help.figma.com/hc/en-us/articles/42495147242903-Tools-and-example-prompts)
- [Running PHPUnit with the Playground CLI](https://developer.wordpress.org/playground/handbook/guides/phpunit-testing/)
- [UIMatch](https://awesome.ecosyste.ms/projects/github.com%2Fkosaki08%2Fuimatch) and [VisualCheck](https://pypi.org/project/visualcheck/)
