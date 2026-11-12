---
name: compound
description: Run the compounder over recent merged PRs and pipeline runs.
disable-model-invocation: true
argument-hint: "[--since YYYY-MM-DD] [--repo owner/name] [--window days] [--offline]"
---

Open with `Route: compound, because /compound forces it.`

The compounder asks two questions: what slipped through, and what slowed the pipeline down. The quality half reads merged PRs through `gh`, and the efficiency half reads the run logs. Each lesson then ships to the pipeline repo, the standards repo or this project, once the developer picks it.

Each Bash call is one plain `pipeline` command, with no `;`, `&&` or pipes. Pass `--since` from the arguments to both miners, and `--repo`, `--window` and `--offline` to the quality command only.

1. Run `pipeline compound quality --out .pipeline/compound/quality.json` with its arguments. When it exits 2, say why in one line and go on.
2. Run `pipeline compound efficiency --out .pipeline/compound/efficiency.json` with its arguments. When it exits 2 because there are no run logs yet, say the plugin's hooks write them as sessions run, and go on.
3. For each command that exited 0, dispatch its analyst, both in one message when both did. The `dev-pipeline:quality-analyst` agent gets one line, `Analyse the quality report at .pipeline/compound/quality.json.`, and the `dev-pipeline:efficiency-analyst` agent gets `Analyse the efficiency report at .pipeline/compound/efficiency.json.` When neither exited 0, stop.
4. Preview the issue of each lesson bound for the pipeline or standards repo. A missed class runs `pipeline compound file --class <fingerprint> --lesson "<Lesson>" --becomes "<Becomes>" --dry-run`, and an efficiency proposal runs `pipeline compound file --finding "<Finding>" --target <Target> --becomes "<Change>" --dry-run`, each value copied word for word from the field of that name in the analyst's reply. Add `--to standards` for the standards repo. When the command refuses the sentence, rewrite it in general words without what it names and run it again. `Already counted` means this evidence was filed before, so that lesson drops out.
5. Draft the edit of each project lesson in this repo: a lint rule or hook ahead of a line in the notes file, a path rule or signal in `sensitive.yml`, or a key in `.pipeline/profile.yml`. Edit nothing yet.
6. Reply once. Give each analyst's reply word for word, the quality one under `What slipped through` and the efficiency one under `What slowed the pipeline down`. Then under `Proposals`, number each lesson with its destination, followed by its issue preview or its drafted edit. End by asking which numbers to ship, and stop. The pipeline repo is public, so an issue is filed and an edit made only for the numbers the developer names.
7. For each number the developer names, run its command again without `--dry-run`, or make its edit and leave it uncommitted. Report each issue's link and count. When a count reaches 3, say the class is ready for a PR on that repo: a quality PR carries a synthetic eval case that fails before the change and passes after, and an efficiency PR a before and after measurement on the same eval cases.
