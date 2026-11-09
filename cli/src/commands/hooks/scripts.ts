export const MARKER = "# pipeline-hook:";

export const hookNames = ["pre-commit", "pre-push"] as const;
export type HookName = (typeof hookNames)[number];

// Single quotes keep the install path literal in the shell, whatever characters it holds.
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function header(name: HookName, bin: string): string {
  return `#!/bin/sh
${MARKER} ${name}
# Installed by "pipeline hooks install", which rewrites this file. An existing hook was kept as ${name}.local and runs after the scan.
default_bin=${quote(bin)}
PIPELINE_BIN="\${PIPELINE_BIN:-$default_bin}"
if [ ! -x "$PIPELINE_BIN" ]; then
  PIPELINE_BIN="$(command -v pipeline)" || {
    echo "pipeline ${name}: the pipeline CLI is missing. Run \\"pipeline hooks install\\" again, or delete this hook." >&2
    exit 1
  }
fi
hook_dir="$(dirname "$0")"
`;
}

export function preCommitScript(bin: string): string {
  return `${header("pre-commit", bin)}
"$PIPELINE_BIN" secrets --staged || exit 1

if [ -x "$hook_dir/pre-commit.local" ]; then
  exec "$hook_dir/pre-commit.local" "$@"
fi
`;
}

export function prePushScript(bin: string): string {
  return `${header("pre-push", bin)}
# Git sends one line per pushed ref on stdin. The chained hook needs the same lines.
refs="$(cat)"
zero="0000000000000000000000000000000000000000"
status=0

while read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "$local_sha" ] || continue
  # A deletion pushes no commits.
  [ "$local_sha" != "$zero" ] || continue
  # An all-zero remote sha is a new ref, which "secrets --range" reads as the commits no remote branch holds.
  "$PIPELINE_BIN" secrets --range "$remote_sha..$local_sha" || status=1
done <<REFS
$refs
REFS

[ "$status" -eq 0 ] || exit 1

if [ -x "$hook_dir/pre-push.local" ]; then
  if [ -n "$refs" ]; then printf '%s\\n' "$refs"; fi | "$hook_dir/pre-push.local" "$@"
  exit $?
fi
`;
}

export function scriptFor(name: HookName, bin: string): string {
  return name === "pre-commit" ? preCommitScript(bin) : prePushScript(bin);
}
