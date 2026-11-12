#!/usr/bin/env bash
# Seeds a WordPress shop whose last fetch of merged PRs sits in the compounder's cache, so /compound --offline reads it with no network.
# Reviewers caught a missing nonce on three settings PRs whose plans named no zone, and asked for a Yoda condition on three more.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
source "$here/../../fixtures/pipeline-cli.sh"

git init -q -b main
git config user.email dana@example.com
git config user.name "Dana Dev"
git remote add origin git@github.com:example/shop.git
mkdir -p includes/admin .pipeline/compound/github
printf '.pipeline/\n' > .gitignore
printf '<?php\n// Shop settings.\n' > includes/admin/class-settings.php
printf '<?php\n// Cart totals.\n' > includes/class-cart.php
printf 'stack: wordpress\n' > .pipeline/profile.yml
git add -A
git commit -q -m "feat: initial shop"

# Dates sit a few days back from today, so the quality command's default 30 day window always holds them.
node - > .pipeline/compound/github/example__shop.json <<'JS'
const day = (back, hour = 10) => new Date(Date.now() - back * 864e5 + hour * 36e5).toISOString().replace(/\.\d+Z$/, "Z");
const settings = "includes/admin/class-settings.php";
const cart = "includes/class-cart.php";
const record = (skipped) => ({ version: 2, pipeline: "0.1.0", tiers: ["T2"], zones: [], skipped, findings: { opened: 1, fixed: 1, accepted: 0 } });
const human = (body, path, zones, back) => ({ author: "riley", kind: "human", body, path, zones, at: day(back, 9) });
const agent = (back) => ({ author: "dana", kind: "agent", body: null, path: null, zones: [], at: day(back, 8) });
const reply = (back) => ({ author: "dana", kind: "author", body: null, path: null, zones: [], at: day(back, 9) });
const pr = (number, back, title, path, zones, comments, rec) => ({ number, title, author: "dana", mergedAt: day(back), mergeSha: `m${number}`, base: "main", files: [{ path, zones }], comments, record: rec });
const nonce = "This saves the posted settings without checking a nonce, so another site can submit the form for an admin.";
const yoda = "Our convention is a Yoda condition here: put the literal on the left of the comparison.";
const prs = [
  pr(11, 20, "feat(settings): save the shipping options", settings, ["input"], [human(nonce, settings, ["input"], 20), reply(20), agent(20)], record([])),
  pr(12, 18, "feat(settings): import options from a file", settings, ["input"], [human(nonce, settings, ["input"], 18), reply(18)], record([{ gate: "quick security review", reason: "the security reviewer was not built" }])),
  pr(13, 15, "feat(settings): reset the options to defaults", settings, ["input"], [human(nonce, settings, ["input"], 15)], record([])),
  pr(14, 14, "feat(cart): free shipping over the threshold", cart, [], [human(yoda, cart, [], 14), reply(14)], null),
  pr(15, 12, "feat(cart): round the tax line", cart, [], [human(yoda, cart, [], 12)], null),
  pr(16, 10, "feat(cart): hide empty fees", cart, [], [human(yoda, cart, [], 10)], null),
  pr(17, 8, "docs: the readme", "readme.txt", [], [], null),
];
const commits = [
  { sha: "f12", subject: "fix(settings): verify the nonce before an import", message: "fix(settings): verify the nonce before an import", at: day(17), files: [{ path: settings, zones: ["csrf", "input"] }] },
];
process.stdout.write(JSON.stringify({ version: 1, repo: "example/shop", fetchedAt: day(1), since: day(30), prs, commits }));
JS
