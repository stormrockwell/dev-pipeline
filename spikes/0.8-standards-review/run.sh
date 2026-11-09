#!/usr/bin/env bash
# Usage: run.sh <A|B> <label> <sha>. Runs one fresh headless Claude Code review in a per-sample worktree of the clone.
set -euo pipefail
ARM="$1"; LABEL="$2"; SHA="$3"
SPIKE=/private/tmp/claude-501/-Users-storm-Documents-web-dev-pipeline/7df149e5-21ef-434e-b568-a870815a6fbc/scratchpad/spike-0.8
REPO=$SPIKE/repo
RULES=/Users/storm/Documents/web/dev-pipeline/research/alibaba_open-code-review/internal/config/rules/rule_docs
DD=/Users/storm/Documents/web/dev-pipeline/research/demanddrive_coding-standards
OUT=$SPIKE/out; mkdir -p "$OUT" "$SPIKE/wt"
WT=$SPIKE/wt/$LABEL
[ -d "$WT" ] || git -C "$REPO" worktree add -q --detach "$WT" "$SHA"
cd "$WT"
MSG=$(git log -1 --format=%B "$SHA")

if [ "$ARM" = A ]; then
  # Borrowed rules: pick files and rule docs by extension in this script.
  FILES=$(git show --name-only --format= "$SHA" | grep -E '\.(php|js|jsx|ts|tsx)$' || true)
  RULETEXT=""
  echo "$FILES" | grep -q '\.php$' && RULETEXT+=$'\n\n## PHP rules\n'"$(cat "$RULES/php.md")"
  echo "$FILES" | grep -qE '\.(js|jsx|ts|tsx)$' && RULETEXT+=$'\n\n## JS/TS rules\n'"$(cat "$RULES/ts_js_tsx_jsx.md")"
  echo "$FILES" | grep -q '\.php$' && RULETEXT+=$'\n\n## DemandDrive PHPCS ruleset\n'"$(cat "$DD/src/Standards/DemandDrive/ruleset.xml")"
else
  # Delegation: OCR picks files and resolves rules.
  PREVIEW=$(cd "$WT" && npx -y @alibaba-group/open-code-review delegate preview -c "$SHA" 2>"$OUT/$LABEL.B.preview.err")
  FILES=$(echo "$PREVIEW" | sed -n 's/^  - `\(.*\)` \[.*$/\1/p')
  RULETEXT=$'\n\n'"$(cd "$WT" && npx -y @alibaba-group/open-code-review delegate rule $FILES 2>"$OUT/$LABEL.B.rule.err")"
fi

DIFF=""
for f in $FILES; do DIFF+=$'\n'"$(git --no-pager show --no-ext-diff --no-textconv --no-color --format= -U5 "$SHA" -- "$f")"; done

PROMPT="You are a code reviewer enforcing coding standards on one commit. Read-only: do not edit files. Use Read, Grep and Glob for context only when needed.
Commit message:
$MSG

Review rules:$RULETEXT

Diff to review:
$DIFF

Report only defects that violate the rules above in the changed lines. Output ONLY JSON lines, one object per finding, with keys file, line, rule, severity (high|medium|low), message. Output nothing if there are no findings."

echo "$FILES" > "$OUT/$LABEL.$ARM.files"
echo "$PROMPT" > "$OUT/$LABEL.$ARM.prompt.txt"
claude -p --model sonnet --output-format json --no-session-persistence \
  --allowedTools "Read,Grep,Glob" --disallowedTools "Edit,Write,Bash" --permission-mode dontAsk \
  "$PROMPT" > "$OUT/$LABEL.$ARM.json" 2> "$OUT/$LABEL.$ARM.err" || echo "run failed" >> "$OUT/$LABEL.$ARM.err"
python3 - "$OUT/$LABEL.$ARM.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print(sys.argv[1].split('/')[-1], 'ms',d.get('duration_ms'),'out_tokens',d.get('usage',{}).get('output_tokens'),'cost',d.get('total_cost_usd'))
PY
