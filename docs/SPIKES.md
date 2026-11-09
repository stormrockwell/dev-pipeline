# Phase 0 Spike Results

Each spike answered one question with numbers. Details and raw tables live in `docs/spikes/`, and the scripts in `spikes/`.

| Spike | Question | Answer | Decision |
|---|---|---|---|
| 0.3 | What does the pilot's history look like? | Media on Autopilot's `main` has 6 merged PRs, 16 commits, 25% conventional titles, no reverts, 1 fix commit and no review comments | squash titles need the conventional PR title check; there is no human review history to score agents against |
| 0.4 | Can WordPress integration suites run in parallel? | With a shared database, 4 runs gave 1 hang, 1 error and 2 passes. With a database per copy, 4 of 4 passed in both rounds at solo speed (about 48 s). Playground CLI could not run wp-phpunit, because child processes fail under it | a test database per worktree; Playground parked |
| 0.5 | Is `claude plugin eval` enough for the eval suite? | 3 planted-defect cases and 1 clean control all passed, once each | yes for planted regressions; severity and precision need `llm` graders, and real suites run each case 3 times |
| 0.6 | Does a rules-only zone scan find sensitive code? | After a parser fix and a self-test covering all 8 categories, the MCP server shows 26 authorization matches in 20 files, and Media on Autopilot 5 of 40 commits with zones and 1 weakened control | the rules miss data writes from untrusted input, such as `update_option`, `wp_insert_post` and menu updates in the MCP server |
| 0.7 | How much plan usage does a work order cost? | Blocked, because the BunnyCDN session transcripts were deleted | deferred to the first instrumented work order in Phase 2; the usage script is ready |
| 0.8 | Borrowed OCR rules or OCR delegation? | Both caught 3 of 3 planted issues. On 5 real commits, delegation found 4 valid issues and 3 noise, and borrowed rules 0 valid and 2 noise, at the same cost | delegation, because its file selection reviewed a SQL file the borrowed arm skipped |

## Open for you

- Mark each row in `docs/spikes/0.6-zone-scan.md` as correct, missed or false alarm.

Data writes from untrusted input became a signal in the `input` zone, as decision 14 records.

## Lessons for later phases

- Every test run and agent dispatch needs a hard timeout. The first 0.4 attempt stalled for ten minutes on a run that hung on the shared database.
- An APFS clone of a 157 MB site costs about 6 MB of real disk.
- The eval harness needs `--trust-plugin` and `--no-publish` for headless runs, and scaffold scripts must set `git config user.*`.
- One run per case gives no variance, so none of these counts are final.
