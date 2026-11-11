#!/bin/sh
# Usage: scripts/matrix.sh <args to node...>
# Runs `node <args>` on every Node in the matrix, printing the version, the output
# and the exit code. Run scripts/get-nodes.sh first. Paths are relative to the spike.
cd "$(dirname "$0")/.." || exit 1
NODE26="${NODE26:-$(command -v node)}"
for n in .nodes/22.15.0/bin/node .nodes/24.22.2/bin/node "$NODE26"; do
  echo "===== $("$n" -v) ====="
  "$n" "$@"
  echo "----- exit $? -----"
done
