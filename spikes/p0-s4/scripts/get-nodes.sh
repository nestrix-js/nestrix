#!/bin/sh
# Downloads Node 22.15.0 and the latest 24.x into .nodes/ (no system install).
# Node 26 is whatever `node` is on PATH (local: 26.13.0), or set NODE26=/path/to/node.
set -e
cd "$(dirname "$0")/.."
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) plat=darwin-arm64 ;;
  Darwin-x86_64) plat=darwin-x64 ;;
  Linux-x86_64) plat=linux-x64 ;;
  Linux-aarch64) plat=linux-arm64 ;;
  *) echo "unsupported platform" >&2; exit 1 ;;
esac
for v in ${NODE_VERSIONS:-22.15.0 24.22.2}; do
  [ -x ".nodes/$v/bin/node" ] && continue
  mkdir -p ".nodes/$v"
  curl -fsSL "https://nodejs.org/dist/v$v/node-v$v-$plat.tar.gz" | tar xz -C ".nodes/$v" --strip-components=1
done
ls .nodes
