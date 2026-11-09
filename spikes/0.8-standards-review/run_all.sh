#!/usr/bin/env bash
# Runs both arms over all eight samples, sequentially.
cd "$(dirname "$0")"
SAMPLES="planted1:24035e9 planted2:9f78d94 planted3:d6ac5d2 real1:3afd4b0 real2:868c750 real3:d21d113 real4:7f96e72 real5:d838d2f"
for s in $SAMPLES; do for arm in A B; do
  ./run.sh $arm "${s%%:*}" "${s##*:}" || echo "FAILED $arm $s"
done; done
