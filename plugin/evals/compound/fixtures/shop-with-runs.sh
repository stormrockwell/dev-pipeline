#!/usr/bin/env bash
# Seeds a Node shop with three sessions of run logs and a ledger, so the compounder has telemetry to read.
# Every implementer prepares its worktree with the same three commands and commits by hand three times,
# two runs pass a failing test on an identical rerun, and task 2's review opens findings in its third round.
set -euo pipefail
here="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
source "$here/../../fixtures/pipeline-cli.sh"

git init -q -b main
git config user.email dana@example.com
git config user.name "Dana Dev"
mkdir -p src .pipeline/runs .pipeline/work/ship
printf 'node_modules/\n.pipeline/\n' > .gitignore
printf '{ "name": "shop-demo", "private": true, "scripts": { "test": "node --test" } }\n' > package.json
printf 'export const rate = 5;\n' > src/shipping.js
printf 'stack: node\n' > .pipeline/profile.yml
git add -A
git commit -q -m "feat: initial shop"

at() { printf '2026-11-%02dT10:%02d:%02d.000Z' "$1" "$(($2 / 60))" "$(($2 % 60))"; }
tool() { # day second agent tool input ok
  printf '{"at":"%s","agent":"a%s","agentType":"dev-pipeline:implementer","kind":"tool","tool":"%s","input":"%s","ok":%s,"ms":%s}\n' "$(at "$1" "$2")" "$3" "$4" "$5" "$6" "${7:-900}"
}
main() { # day second kind rest
  printf '{"at":"%s","kind":"%s"%s}\n' "$(at "$1" "$2")" "$3" "$4"
}
dispatch() { # day second agent
  printf '{"at":"%s","kind":"dispatch","agent":"a%s","type":"dev-pipeline:implementer","model":"claude-sonnet-5-5","turns":40,"tokens":{"input":2000,"output":9000,"cacheRead":900000,"cacheWrite":30000},"ms":600000,"work":"ship","task":"%s"}\n' "$(at "$1" "$2")" "$3" "$3"
}

for s in 1 2 3; do
  log=".pipeline/runs/session-$s.jsonl"
  wt=".pipeline/work/ship/worktrees/$s"
  {
    main "$s" 0 session ',"source":"startup","transcript":null'
    main "$s" 5 prompt ',"text":"build task '"$s"'"'
    main "$s" 20 stage ',"name":"build"'
    tool "$s" 30 "$s" Bash "git fetch -q origin" true
    tool "$s" 40 "$s" Bash "git worktree add -q -b feat/task-$s $wt origin/main" true
    tool "$s" 90 "$s" Bash "npm ci --prefix $wt" true 48000
    tool "$s" 100 "$s" Read "$wt/.pipeline/task/brief.md" true 20
    tool "$s" 120 "$s" Edit "$wt/src/shipping.js" true 30
    if [ "$s" != 3 ]; then
      tool "$s" 150 "$s" Bash "npm test --prefix $wt" false 7000
      tool "$s" 170 "$s" Bash "npm test --prefix $wt" true 7000
    fi
    for c in 1 2 3; do
      tool "$s" $((200 + c * 60)) "$s" Bash "git -C $wt add -A" true 200
      tool "$s" $((210 + c * 60)) "$s" Bash "git -C $wt commit -q -m 'feat(shipping): part $c of task $s'" true 300
      tool "$s" $((230 + c * 60)) "$s" Edit "$wt/src/shipping.js" true 30
    done
    dispatch "$s" 500 "$s"
    if [ "$s" = 1 ]; then dispatch "$s" 560 "$s"; fi
    main "$s" 600 stop ',"model":"claude-opus-5-5","turns":30,"tokens":{"input":900,"output":4000,"cacheRead":500000,"cacheWrite":20000}'
  } > "$log"
done

{
  printf '{"kind":"round","at":"%s","task":"2","round":1,"scope":"full","head":"a1","opened":4,"fixed":0}\n' "$(at 2 700)"
  printf '{"kind":"round","at":"%s","task":"2","round":2,"scope":"fix","head":"a2","opened":2,"fixed":3}\n' "$(at 2 800)"
  printf '{"kind":"round","at":"%s","task":"2","round":3,"scope":"fix","head":"a3","opened":2,"fixed":2}\n' "$(at 2 900)"
} > .pipeline/work/ship/ledger.jsonl
