#!/bin/sh
# Q5: install @nestrix-js/nestjs (packed tarball) into a host on OpenTelemetry SDK 2.x.
# Usage: sh scripts/q5-install.sh <empty dir outside the repo>
# Needs `pnpm build` first. Writes every package-manager transcript to <dir>/logs/.
#
# Two tarballs:
#   placeholder  the real packages/nestjs as packed today (peers only, no SDK deps)
#   designed     the same, plus the runtime dependencies architecture.md §4.5 plans
#                (SDK 3 packages), to show what the published package will meet
set -u
OUT=${1:?usage: q5-install.sh <dir>}
SPIKE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$SPIKE/../.." && pwd)
case "$OUT" in "$REPO"*) echo "pick a directory outside the repo" >&2; exit 1 ;; esac
mkdir -p "$OUT/logs" "$OUT/tarballs"
OUT=$(cd "$OUT" && pwd)
LOG="$OUT/logs"

# Versions, resolved live.
API19=$(npm view @opentelemetry/api@'~1.9' version | tail -1 | awk '{print $NF}' | tr -d "'")
SDK2=$(npm view @opentelemetry/sdk-trace-base@'^2' version | tail -1 | awk '{print $NF}' | tr -d "'")
NEST=$(npm view @nestjs/core version)
SDK3=$(npm view @opentelemetry/sdk-trace version)
EXP3=$(npm view @opentelemetry/exporter-trace-otlp-proto version)
UND=$(npm view @opentelemetry/instrumentation-undici version)
SEM=$(npm view @opentelemetry/semantic-conventions version)
echo "api~1.9=$API19 sdk2=$SDK2 nest=$NEST sdk3=$SDK3 exporter=$EXP3 undici=$UND semconv=$SEM" | tee "$LOG/versions.txt"

# Tarballs.
(cd "$REPO/packages/nestjs" && npm pack --pack-destination "$OUT/tarballs" >"$LOG/pack-placeholder.txt" 2>&1)
mv "$OUT/tarballs/nestrix-nestjs-0.0.0.tgz" "$OUT/tarballs/placeholder.tgz"
rm -rf "$OUT/designed-src" && mkdir -p "$OUT/designed-src"
cp -R "$REPO/packages/nestjs/dist" "$REPO/packages/nestjs/package.json" "$OUT/designed-src/"
node -e '
const fs = require("fs"); const p = process.argv[1]; const j = JSON.parse(fs.readFileSync(p));
const [sdk3, exp3, und, sem] = process.argv.slice(2);
j.dependencies = {
  "@opentelemetry/sdk-trace": "^" + sdk3, "@opentelemetry/resources": "^" + sdk3,
  "@opentelemetry/exporter-trace-otlp-proto": "^" + exp3,
  "@opentelemetry/instrumentation-undici": "^" + und,
  "@opentelemetry/semantic-conventions": "^" + sem };
delete j.devDependencies; delete j.scripts;
fs.writeFileSync(p, JSON.stringify(j, null, 2));' "$OUT/designed-src/package.json" "$SDK3" "$EXP3" "$UND" "$SEM"
(cd "$OUT/designed-src" && npm pack --pack-destination "$OUT/tarballs" >"$LOG/pack-designed.txt" 2>&1)
mv "$OUT/tarballs/nestrix-nestjs-0.0.0.tgz" "$OUT/tarballs/designed.tgz"

host_pkg() {
  cat >"$1/package.json" <<EOF
{
  "name": "sdk2-host",
  "private": true,
  "type": "commonjs",
  "dependencies": {
    "@nestjs/common": "^$NEST",
    "@nestjs/core": "^$NEST",
    "@nestjs/platform-express": "^$NEST",
    "@opentelemetry/api": "$API19",
    "@opentelemetry/context-async-hooks": "$SDK2",
    "@opentelemetry/core": "$SDK2",
    "@opentelemetry/sdk-trace-base": "$SDK2",
    "@opentelemetry/sdk-trace-node": "$SDK2",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2"
  }
}
EOF
}

for tgz in placeholder designed; do
  for pm in npm pnpm; do
    D="$OUT/host-$pm-$tgz"
    rm -rf "$D" && mkdir -p "$D"
    host_pkg "$D"
    if [ "$pm" = npm ]; then
      (cd "$D" && npm install --no-audit --no-fund >"$LOG/$pm-$tgz-0-baseline.txt" 2>&1; echo "exit $?" >>"$LOG/$pm-$tgz-0-baseline.txt")
      (cd "$D" && npm install --no-audit --no-fund "$OUT/tarballs/$tgz.tgz" >"$LOG/$pm-$tgz-1-add.txt" 2>&1; echo "exit $?" >>"$LOG/$pm-$tgz-1-add.txt")
      (cd "$D" && npm install --no-audit --no-fund --legacy-peer-deps "$OUT/tarballs/$tgz.tgz" >"$LOG/$pm-$tgz-2-add-legacy-peer-deps.txt" 2>&1; echo "exit $?" >>"$LOG/$pm-$tgz-2-add-legacy-peer-deps.txt")
    else
      (cd "$D" && pnpm install --ignore-workspace >"$LOG/$pm-$tgz-0-baseline.txt" 2>&1; echo "exit $?" >>"$LOG/$pm-$tgz-0-baseline.txt")
      (cd "$D" && pnpm add --ignore-workspace "$OUT/tarballs/$tgz.tgz" >"$LOG/$pm-$tgz-1-add.txt" 2>&1; echo "exit $?" >>"$LOG/$pm-$tgz-1-add.txt")
    fi
  done
done

# pnpm's own listing of the unmet peers (the `add` output only says "Run pnpm peers check").
for tgz in placeholder designed; do
  (cd "$OUT/host-pnpm-$tgz" && pnpm peers check --ignore-workspace >"$LOG/pnpm-$tgz-3-peers-check.txt" 2>&1; echo "exit $?" >>"$LOG/pnpm-$tgz-3-peers-check.txt")
done

# The runtime matrix, from the current q5-runtime.mjs, into one file.
: >"$LOG/runtime.txt"
for host in host-npm-designed host-pnpm-designed host-npm-placeholder host-pnpm-placeholder; do
  for c in host-sdk2 nestrix-only mixed-api mixed-api-diag-only reverse-cm; do
    echo "## $host $c" >>"$LOG/runtime.txt"
    node "$SPIKE/scripts/q5-runtime.mjs" "$OUT/$host" "$c" >>"$LOG/runtime.txt" 2>&1
  done
done

echo "done: $OUT"
ls "$LOG"
