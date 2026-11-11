---
name: debug
description: Diagnose a bug locally until a reproduction goes red, then hand the fix to the change route.
disable-model-invocation: true
---

# Debug

Open with `Route: debug, because <symptom>.` unless the router already did. Diagnosis comes before any fix: no source edit until a reproduction is red and you can name the root cause.

Staging and production stay read-only. Evidence comes from the developer and from local runs, so remote shells, remote WP-CLI aliases and requests to live sites stay out of your commands. Logs and database copies hold personal data, so handle them like secrets. They stay on this machine outside the repo and out of commits, PRs, issues, artifacts and outside services, and a report quotes only the lines it needs, with personal data masked.

Run each command as its own Bash call, because permission rules check every part of a compound command. Change files with the Edit and Write tools, never `sed -i` or a shell redirect, because those tools carry Claude Code's write checks and the secret scan hook.

1. **Gather.** Collect the error message, stack trace and logs the developer gave you, and read the code path the symptom names. Ask for a log only when the code offers no lead.
2. **Branch.** Run `git switch -c fix/<slug>`, so the reproduction stays off the default branch.
3. **Reproduce until red.** Write the smallest test in the repo's suite that fails the way the symptom does, or a script in `.pipeline/tests/` when there is no suite, and run it. Done when the run is red with the same error.
4. **Diagnose.** Shrink the failing input, test one hypothesis at a time, and instrument with a log line or an assertion when reading is not enough. Remove the instrumentation afterwards. Done when one sentence names the root cause and the red run proves it.
5. **Hand off.** Report the root cause, the evidence (the red command and its output), the reproduction path and the fix you propose. Name each log or database copy the diagnosis used, for the developer to delete once the fix ships. Then open the change route with `Route: change, because <the fix>.` and follow the router's change row, with the red test as the task's regression test. When the root cause is a security flaw, the fix is T3. In a distributed project it also ships quietly, so title the task by the behavior the fix restores and never by the flaw, because the title reaches the commits, the changelog and the PR.
