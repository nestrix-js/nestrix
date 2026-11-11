#!/usr/bin/env bash
# Usage: run.sh <esm|cjs> <work-dir>
#
# Packs the published packages (the workspace must already be built), copies the fixture app to
# <work-dir>, outside the workspace, installs the tarballs and the peer dependencies with npm,
# and boots the app. Run it from anywhere; it needs `pnpm`, `npm` and `node` on PATH.
set -euo pipefail

format="${1:?usage: run.sh <esm|cjs> <work-dir>}"
work="${2:?usage: run.sh <esm|cjs> <work-dir>}"

case "$format" in
  esm | cjs) ;;
  *)
    echo "format must be esm or cjs, got: $format" >&2
    exit 2
    ;;
esac

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

rm -rf "$work"
mkdir -p "$work/tarballs" "$work/app"
work="$(cd "$work" && pwd)"

for pkg in nestjs ui; do
  (cd "$root/packages/$pkg" && pnpm pack --pack-destination "$work/tarballs")
done
ls -l "$work/tarballs"

cp "$here/$format/"* "$work/app/"
cd "$work/app"

# Required peers of @nestrix-js/nestjs, with the ranges from its package.json, plus the adapter.
peers=()
while IFS= read -r peer; do peers+=("$peer"); done < <(node -e '
  const p = require(process.argv[1]);
  const optional = p.peerDependenciesMeta ?? {};
  for (const [name, range] of Object.entries(p.peerDependencies ?? {}))
    if (!optional[name]?.optional) console.log(`${name}@${range}`);
' "$root/packages/nestjs/package.json")
echo "peers: ${peers[*]}"

npm install --no-audit --no-fund --loglevel=error \
  "$work"/tarballs/nestrix-js-nestjs-*.tgz \
  "$work"/tarballs/nestrix-js-ui-*.tgz \
  "${peers[@]}" \
  "@nestjs/platform-express@^12"

echo "node $(node --version), format $format"
node main.js
