# Execution Plan

This plan turns `STRATEGY.md` into ordered work. Each phase ends at a test that proves it, and each task names its executor, following the strategy's routing rule: the cheapest executor that can do the job.

## Assumptions

- One builder (you) working with Claude Code, sharing the pipeline once it is complete.
- The repo lives under the stormrockwell account and uses trunk-based development. No releases are cut while the pipeline is built, and the first release ships when it is ready.
- Three pilot repos: Media on Autopilot (an existing WordPress plugin with unit, integration and JS suites, used as a test bed and never as an example of good practice), the MCP server (a WordPress plugin whose abilities save posts, settings and menus, so it exercises the security zones hardest), and a fresh Node demo site (a new project). An eval fixture repo stands in for an existing codebase without tests.
- Every model call runs through Claude Code on the team's plans.
- The pipeline repo dogfoods its own rules from Phase 1 on: TDD, linters, PRs and auditor lists.

| Executor | Use it for |
|---|---|
| Script | anything with one correct output, at zero tokens |
| Haiku | mechanical work: configs, small scripts, file moves |
| Sonnet | code built test-first, and measurement |
| Opus | prompts, skills, shaping and judgment |
| You | decisions, access, approvals |

## Repo layout

```
dev-pipeline/
  docs/          strategy, plan, v2 ideas, the original brief, spike results
  plugin/        Claude Code plugin: router, skills, agents, hooks
  cli/           the pipeline CLI: check, classify, scan-zones, docs, doctor
  github/        reusable workflows, ruleset template, risk-gate
  evals/         claude plugin eval cases
  tools/docs/    docs viewer, until it moves into the CLI
  research/      reference clones, git-ignored
```

## Phase 0: decisions and spikes

| ID | Task | Executor | Needs | Done when |
|---|---|---|---|---|
| 0.1 | Done: decisions 1, 3, 7 and 13 settled; Phase 3 targets set at 90% recall and at most 10% false alarms | You | | recorded in `docs/STRATEGY.md` |
| 0.2 | Create the pipeline repo under stormrockwell: protected `main` as the trunk, squash merges, conventional PR titles, a `.gitignore`, and no release workflow until ship | Claude | | the first PR merges through protection |
| 0.3 | Baseline Media on Autopilot's history: changes per week, review comments, time to merge, reverts | Haiku writes a `gh api` script | 0.2 | numbers in `docs/SPIKES.md` |
| 0.4 | Spike parallel WordPress tests: per-worktree SQLite against Playground CLI, four runs at once | Sonnet | | time, flakiness and a pick recorded |
| 0.5 | Spike the eval harness: a minimal plugin with three planted-defect cases | Sonnet | | scaffold, regex graders and sandbox proven |
| 0.6 | Spike the zone scan: a prototype scanner over Media on Autopilot's history and the MCP server's code, compared with your calls | Haiku builds it, you judge | 0.3 | recall and false alarms per zone category |
| 0.7 | Deferred: the BunnyCDN transcripts are gone, so the first instrumented work order in Phase 2 sets the plan usage baseline, using `spikes/0.7-usage/usage.mjs` | | | |
| 0.8 | Spike standards review: borrowed OCR rules against OCR delegation | Sonnet | | precision, recall and usage per arm, pick recorded |

Tasks 0.4, 0.5, 0.7 and 0.8 share nothing and run in parallel.

**Exit.** `docs/SPIKES.md` answers every spike with numbers, and the Phase 3 targets are set.

## Phase 1: the floor

| ID | Task | Executor | Needs | Done when |
|---|---|---|---|---|
| 1.1 | Standards repo: flat ESLint config, base and WordPress layers for ESLint, Stylelint and PHPCS, real sniff tests, CI, one version scheme, a call on `react-hooks/exhaustive-deps` | Sonnet, test-first on the sniffs | access to the standards repo | a Node project and a WordPress project both lint clean from it |
| 1.2 | CLI skeleton in Node and TypeScript, with Vitest and the standards base layer | Sonnet | 1.1 base layer | `pipeline --help` lists every command |
| 1.3 | `pipeline check`: detects and runs the floor's tools, and explains any missing one | Sonnet | 1.2 | same results locally and in CI on Media on Autopilot |
| 1.4 | Secret defense: write-scan hook, pre-commit and pre-push hooks, sensitive file blocklist, hooks installed by the package manager | Sonnet | 1.2 | planted secret cases block at commit |
| 1.5 | Guardrails: permissions template and the shell-tokenizer command hook | Sonnet | 1.2 | boundary eval cases pass |
| 1.6 | Zone scan and classifier: `sensitive.yml` schema, WordPress and Node signal packs, removed-signal detection, tier per diff | Sonnet | 0.6 | spike recall matched or beaten |
| 1.7 | Comment linter | Haiku | 1.2 | the temporal comment fixtures get flagged |
| 1.8 | PR template and body checker: sections, 250-word ceiling, auditor list | Haiku | 1.2 | good fixtures pass, padded ones fail |
| 1.9 | GitHub layer: reusable workflow, ruleset template, labels, `risk-gate` | Sonnet; you review as the peer until the pipeline is shared | 1.6, 1.8 | a zone PR cannot merge without a peer approval |
| 1.10 | `pipeline docs`, with watch mode | Haiku | 1.2 | edits show on refresh |
| 1.11 | Pilot the floor on Media on Autopilot and the MCP server: baseline old violations, tune false positives | You and Sonnet | 1.3 to 1.9 | 20 consecutive PRs with no false-positive blocks |

After 1.2, tasks 1.3, 1.4, 1.5, 1.7, 1.8 and 1.10 share nothing and run in parallel.

**Exit.** Two repos run the floor locally and in CI with the same results, the secret and boundary cases pass, and nobody bypassed a hook to get work done during the pilot.

## Phase 2: the router and the change route

| ID | Task | Executor | Needs | Done when |
|---|---|---|---|---|
| 2.1 | Plugin skeleton: manifest, router skill, SessionStart pointer, optional `/work`, `/review` and `/compound` | Opus for the router, Sonnet for wiring | Phase 1 | routing eval cases pass |
| 2.2 | Init and bootstrap: profile detection and questions, and new-project setup of the suite, linters, CI, hooks and profile | Sonnet; Opus for the questions | 1.1, 1.3, 1.4 | scenario 1 passes its bootstrap checks |
| 2.3 | Work order: shaping with owned files and interfaces, per-task classification, peer-only lowering, schedule script, one-screen render, involvement levels | Opus for shaping, Haiku for the schedule script | 1.6, decisions 9, 10, 11 | judgment eval cases pass |
| 2.4 | Implementer: task brief script, report contract with TDD evidence, Stop hook fast checks | Sonnet, adapting Superpowers' implementer prompt | 2.3 | a task ships with red and green evidence |
| 2.5 | Worktree isolation: per-worktree test database, APFS dependency clones, ports, merge serializer | Sonnet | 0.4 | two zero-overlap tasks run in parallel without collisions |
| 2.6 | Reviewers v1: spec with the test checklist, standards in the mode 0.8 picked, simplifier, findings schema, merge by precedence, routed three-round fix loop | Opus for reviewer prompts, Sonnet for plumbing | 2.4, decision 12 | precedence and routing eval cases pass |
| 2.7 | Ledger, run log and gate record | Haiku | 2.3 | every run writes a complete log |
| 2.8 | Finish: version sync script, docs agent, auditor list, draft PRs after asking, labels | Haiku for version sync, Sonnet for the rest | 1.8, 1.9, 2.7 | writing eval cases pass |
| 2.9 | Other routes: answer, quick change, report, debug, spike | Opus for skill text, Sonnet for wiring | 2.1 | scenarios 3 and 4 pass |
| 2.10 | Eval suite in CI, with a pinned model and plan OAuth | Sonnet | 0.5 | the suite runs on every pipeline PR |

Decision 4 (environment profile) is needed before teammates join in Phase 5.

**Exit.** All four scenarios pass as plugin evals, one real feature ships on Media on Autopilot through the change route, a risky change on the MCP server lands as a zone PR, and the first work orders record the plan usage baseline that 0.7 could not.

## Phase 3: security, performance, accessibility and design

| ID | Task | Executor | Needs | Done when |
|---|---|---|---|---|
| 3.1 | Security reviewer: light, quick and full depths, WordPress companion, adversarial verifier, review guide, per-SHA status, never-parked rule | Opus for prompts and the companion, Sonnet for plumbing | 2.6 | the planted suite reaches 90% recall |
| 3.2 | Mutation check on zone code | Sonnet | 3.1 | a tautological security test blocks the PR |
| 3.3 | Planted vulnerability suite and clean controls | Sonnet writes the cases, Opus reviews them | 0.5 | at least two cases per zone category |
| 3.4 | Reach check: the callers of changed functions | Sonnet | 1.6 | the helper gap case passes |
| 3.5 | Performance reviewer and the N+1 query-count helper | Sonnet | 2.6 | performance eval cases pass |
| 3.6 | Accessibility: axe with baselines, and the agent keyboard pass | Sonnet | 1.3 | an accessibility regression blocks |
| 3.7 | Design reviewer: evaluate UIMatch and VisualCheck, then the token, wireframe and pixel checks | Sonnet | decision 8 | one frame passes and one planted drift fails |
| 3.8 | Close the scenario gaps: credentials rule, API mocking, webhook signals, production evidence rule, quiet security fixes | Opus | section 15 | the strategy and skills cover each gap |

Tasks 3.4, 3.5, 3.6 and 3.7 share nothing and run in parallel.

**Exit.** The planted suite meets the recall target, clean controls stay under the false-alarm target, the mutation check catches a test that proves nothing, and the security reviewer run over the MCP server flags every permission and input boundary you marked in 0.6.

## Phase 4: the compounder

| ID | Task | Executor | Needs | Done when |
|---|---|---|---|---|
| 4.1 | Quality half: gate records, human comments, `fix:` commits and skips across repos | Sonnet | 2.7, decision 5 | a weekly report lists the top missed classes |
| 4.2 | Efficiency half: stage times, loops, misroutes and repeated tool-call sequences | Haiku for the sequence miner, Sonnet for the analysis | 2.7 | the first repeated sequence becomes a script |
| 4.3 | Proposal flow: PRs carrying eval cases or before and after measurements, on a weekly schedule | Opus | 4.1, 4.2 | two compounder PRs merged |
| 4.4 | Metrics page for quality, human attention and efficiency | Haiku | 4.1 | the page shows data from every pilot repo |

**Exit.** Two compounder PRs have merged, each with its eval or measurement.

## Phase 5: scale

- Cut the first release, v1.0.0, once the pipeline is ready to ship, then share it with two developers before the whole team.
- Run CI-side Claude Code review with plan OAuth, if decision 6 says yes.
- Schedule deep security audits.
- Add the post-merge layer: staging smoke tests, release channels and a documented rollback.
- Move T0 and T1 to zero approvals once their revert rates stay flat over 100 merged PRs per tier.
- Apply the brand kit to the docs viewer and every artifact.
- Revisit `V2.md`.

## Risks

| Risk | Early signal | Response |
|---|---|---|
| Plan limits at 100 to 250 PRs a week | the 0.7 baseline and the run logs | security per push, model tiering, fewer review rounds |
| False positives slow developers down | the pilot and the skip rate | tune before rollout, because the floor must stay quiet on clean code |
| Playground PHPUnit falls short | spike 0.4 | per-worktree SQLite |
| A personal account lacks features such as Secret Protection and rulesets | decision 13 and 0.1 | the local hooks, the `.claude/settings.json` denials and CI scans, until the pipeline goes public |
| The standards repo is slow to accept PRs | task 1.1 | fork it under the pipeline's org |
| Claude Code changes underneath the pipeline | the eval suite on each release | pin versions, and rerun evals on every model and CLI release |
