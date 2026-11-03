#!/usr/bin/env bash
# Packs the package exactly as npm would publish it, installs the tarball into a throwaway prefix and checks the
# installed copy: --version works, the dashboard starts and serves / and /api/unharness, --stop stops it. Also fails
# if any shipped file contains the checkout's absolute path (a build-machine path leak).
#
# Needs a build first: `npm run smoke` runs `npm run build` and then this script. It packs with --ignore-scripts,
# so it tests the build already on disk instead of rebuilding it.
# Env: PACK_DIR keeps the tarball there (default: a temp dir, deleted afterwards); SMOKE_PORT (default 4391, away
# from the default 4319 so a dashboard you have running is left alone); TMPDIR for the scratch files.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd -P)
leak=${GITHUB_WORKSPACE:-$root}
port=${SMOKE_PORT:-4391}
cd "$root"

if [ ! -f dashboard/.next/standalone/dashboard/.next/UNHARNESS_BUILD_DONE ] || [ ! -f dist/cli.js ]; then
  echo "no complete build; run npm run build first" >&2
  exit 1
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/unharness-smoke.XXXXXX")
pack_dir=${PACK_DIR:-$work/pack}
mkdir -p "$pack_dir" "$work/extract" "$work/stub" "$work/home"
bin="$work/prefix/bin/unharness"

# The CLI opens a browser after starting the dashboard; these stubs make that a no-op.
printf '#!/bin/sh\nexit 0\n' > "$work/stub/open"
cp "$work/stub/open" "$work/stub/xdg-open"
chmod +x "$work/stub/open" "$work/stub/xdg-open"
run() { PATH="$work/stub:$PATH" UNHARNESS_HOME="$work/home" UNHARNESS_NO_UPDATE_CHECK=1 "$bin" "$@"; }

cleanup() {
  [ -x "$bin" ] && run dashboard --port "$port" --stop > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

echo "== pack"
tgz="$pack_dir/$(npm pack --ignore-scripts --silent --pack-destination "$pack_dir" | tail -n 1)"
echo "$tgz ($(du -h "$tgz" | cut -f1))"

echo "== path leak check ($leak)"
tar -xzf "$tgz" -C "$work/extract"
if grep -rlF "$leak" "$work/extract"; then
  echo "the files above contain the build machine's path $leak" >&2
  exit 1
fi

echo "== install into temp prefix"
npm install -g --prefix "$work/prefix" --no-audit --no-fund --silent "$tgz"
run --version

echo "== dashboard on port $port"
run dashboard --port "$port"
for p in / /api/unharness; do
  code=$(curl -sS -o "$work/body" -w '%{http_code}' "http://127.0.0.1:$port$p")
  echo "GET $p -> $code"
  [ "$code" = 200 ] || { head -c 500 "$work/body" >&2; exit 1; }
done
grep -q '"app":"unharness"' "$work/body" || { echo "/api/unharness is not the Unharness dashboard" >&2; exit 1; }
run dashboard --port "$port" --stop

echo "smoke test passed"
