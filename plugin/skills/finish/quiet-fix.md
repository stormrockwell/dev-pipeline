# Quiet security fix

A PR that fixes a security flaw in a distributed project ships before anyone learns of the flaw, because every site on the released version stays exposed until it updates. Follow these alongside the finish steps for that PR.

1. **Body.** In step 4, give the docs agent a second line: `This PR fixes a security flaw before its release, so describe the behavior it restores and leave out the flaw and how to exploit it.`
2. **Before the ask.** Read `git -C <path> log --format=%s <base>..HEAD` and the changelog entry. When either names the flaw, show the developer those lines and stop until they answer.
3. **Advisory.** In the summary, ask the developer to open a private advisory at `https://github.com/<owner>/<repo>/security/advisories/new` with the flaw's details, and to publish it only after the release that holds the fix ships.
