#!/usr/bin/env bash
# End-to-end demo: runs `arena` against the bundled offline mock model in a
# throwaway project directory, then shows what the agent produced.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEMO_DIR="$(mktemp -d)"
trap 'rm -rf "$DEMO_DIR"' EXIT

cd "$DEMO_DIR"
echo '{"name":"demo-app","version":"0.0.1"}' > package.json
mkdir -p src
echo "console.log('demo app');" > src/index.js

echo "==> arena --mock --full-auto -p \"add authentication to this application\""
echo
node "$HERE/bin/arena.js" --mock --full-auto -p "add authentication to this application"

echo
echo "==> files created by the agent:"
find . -type f | sort
echo
echo "==> src/auth.js:"
cat src/auth.js
