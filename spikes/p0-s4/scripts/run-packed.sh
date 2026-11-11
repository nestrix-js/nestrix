#!/bin/sh
# Installs the packed @nestrix-js/nestjs tarball into a directory OUTSIDE the workspace
# with plain npm (flat node_modules, real copies, no pnpm symlinks), then runs the
# CommonJS app and the OpenTelemetry load check on every Node in the matrix.
#
# Usage: scripts/run-packed.sh <empty-or-new-directory>
# Needs: pnpm build done, scripts/get-nodes.sh done.
set -e
spike="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$spike/../.." && pwd)"
out="$1"
[ -n "$out" ] || { echo "usage: $0 <directory outside the repo>" >&2; exit 1; }
mkdir -p "$out/pack" "$out/app"
out="$(cd "$out" && pwd)"

# 1. pack the built package (this is what would be published)
(cd "$repo/packages/nestjs" && pnpm pack --pack-destination "$out/pack")
tarball="$(ls "$out"/pack/nestrix-nestjs-*.tgz)"
echo "tarball: $tarball"
tar tzf "$tarball"

# 2. fresh npm project, versions pinned to what the spike resolved from the registry
cd "$out/app"
cat > package.json <<'EOF'
{ "name": "packed-consumer", "version": "0.0.0", "private": true, "type": "commonjs" }
EOF
npm install --no-audit --no-fund "$tarball" \
  @nestjs/common@12.4.2 @nestjs/core@12.4.2 @nestjs/platform-express@12.4.2 \
  @opentelemetry/api@1.10.0 @opentelemetry/sdk-trace@3.1.1 @opentelemetry/resources@3.1.1 \
  @opentelemetry/exporter-trace-otlp-http@0.301.1 @opentelemetry/instrumentation-undici@0.35.0 \
  @opentelemetry/semantic-conventions@1.45.0 reflect-metadata@0.2.2 rxjs@7.8.2
ls -la node_modules/@nestrix-js/ node_modules/@nestrix-js/nestjs

# 3. the same compiled app and scripts, now resolving everything from the npm install
rm -rf dist dist-esm scripts tla
cp -R "$spike/dist" "$spike/dist-esm" "$spike/tla" .
mkdir scripts && cp "$spike/scripts/q3b-otel.cjs" scripts/

NODE26="${NODE26:-$(command -v node)}"
for n in "$spike/.nodes/22.15.0/bin/node" "$spike/.nodes/24.22.2/bin/node" "$NODE26"; do
  echo "===== packed install, $("$n" -v) ====="
  "$n" dist/main.js
  "$n" scripts/q3b-otel.cjs | grep -E "^(OK|FAIL)    \(2\)|\(3\)"
done
