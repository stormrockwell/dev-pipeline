---
name: bootstrap
description: Start a new WordPress plugin or Node site with pipeline init, then build each feature as a change.
disable-model-invocation: true
---

# Bootstrap

Open with `Route: new project, because <reason>.` unless the router already did. `pipeline init` writes the whole scaffold from templates: the test suite, the linters, the CI caller workflow, the PR template, the profile, the sensitive paths and the secret hooks. Your job is the questions and the hand-off. Run each command as its own Bash call, because permission rules check every part of a compound command.

1. **Ask.** Settle these, in one message, before writing anything:
   - Throwaway or maintained, when the request says demo or leaves it open. Throwaway goes to the spike route instead.
   - `type`: `wordpress-plugin` or `node-site`.
   - `name`, the directory and slug.
   - `distributed` for a plugin: is it installed on sites the developer does not run?
   - `public` for a site, and `urls` for the accessibility check, defaulting to `/`.
   - `peer_review`: will a second developer review pull requests?

   Skip any the request already answers, and propose a default for the rest. Done when every open question has an answer.
2. **Scaffold.** Run `pipeline init --mode new --path <name> --yes` with one `--answer <key>=<value>` per answer. When it exits 2, it names the missing answer, so ask for that one and run it again. When it exits 1 after its `created` lines, the files are written and a git or hook step failed, so quote its failed lines and go on to step 3 without inspecting or retrying. Done when the files are written.
3. **Ask before anything leaves the machine.** Show the next steps init printed. End the message with one question, whether to run the install command and whether to create the GitHub repo with `gh repo create`, naming owner and visibility. Installs download packages and a repo is outward facing, so stop until the developer answers.
4. **Commit.** Once the installs ran and `pipeline check` passes in `<name>`, stage the scaffold by name and commit `chore: bootstrap <name>`. When the developer skipped the installs, commit anyway and say `pipeline check` waits on them.
5. **First feature.** Each feature takes the change route. Draft its work order with the `dev-pipeline:work-order` skill, test first, and wait for confirmation before editing code.
