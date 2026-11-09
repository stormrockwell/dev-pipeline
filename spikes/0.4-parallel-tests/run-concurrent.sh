#!/usr/bin/env bash
# Runs the integration suite in N copies at once and prints per-run wall time and result.
# Usage: run-concurrent.sh <label> <env-per-copy: yes|no> <copy-dir>...
# With env-per-copy=yes each run gets MOAP_DB_DIR=<copy>/db.
# Env: OUT (log root), TIMEOUT (seconds per run, default 300), CMD (override the test command, run in the plugin dir).
# Every run is killed, with its whole process group, after TIMEOUT seconds and reported as "timeout".
set -u
LABEL=$1; PERCOPY=$2; shift 2
OUT=${OUT:-/tmp}/$LABEL; mkdir -p "$OUT"
TIMEOUT=${TIMEOUT:-300}
CMD=${CMD:-vendor/bin/phpunit -c phpunit-integration.xml.dist --do-not-cache-result}
export TIMEOUT CMD
# Own process group per run, so a hung child cannot outlive the alarm. Exit code 124 means timeout.
RUNNER='use POSIX; my $pid = fork(); if (!$pid) { setpgrp(0,0); exec("/bin/sh","-c",$ENV{CMD}) or exit 127 }
$SIG{ALRM} = sub { kill "KILL", -$pid; kill "KILL", $pid; waitpid($pid,0); exit 124 };
alarm $ENV{TIMEOUT}; waitpid($pid,0); exit(($? >> 8) || ($? & 127));'
start=$(python3 -c 'import time;print(time.time())')
i=0
for d in "$@"; do
  i=$((i+1))
  (
    cd "$d/wp-content/plugins/media-on-autopilot" || exit 99
    if [ "$PERCOPY" = yes ]; then export MOAP_DB_DIR="$d/db"; fi
    s=$(python3 -c 'import time;print(time.time())')
    perl -e "$RUNNER" >"$OUT/run$i.log" 2>&1
    rc=$?
    e=$(python3 -c 'import time;print(time.time())')
    res=rc=$rc; [ "$rc" = 124 ] && res=timeout
    python3 -c "print('run$i $res wall=%.1fs' % ($e-$s))" >"$OUT/run$i.time"
  ) &
done
wait
end=$(python3 -c 'import time;print(time.time())')
for n in $(seq 1 $i); do
  echo "$(cat $OUT/run$n.time) | $(grep -E '^(OK|Tests:)' $OUT/run$n.log | tr '\n' ' ')"
done
python3 -c "print('total wall=%.1fs' % ($end-$start))"
