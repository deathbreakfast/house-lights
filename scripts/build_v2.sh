#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
V2_DIR="$PROJECT_ROOT/src/static/v2"

if [[ ! -d "$V2_DIR" ]]; then
  echo "Cannot find v2 frontend at $V2_DIR" >&2
  exit 1
fi

echo "▶ Building v2 frontend (React + Tailwind)"
cd "$V2_DIR"

if [[ ! -d node_modules ]] || [[ ! -x node_modules/.bin/tailwindcss ]]; then
  echo "• Installing/updating dependencies"
  npm install
fi

echo "• Running npm run build"
npm run build

echo "✔ Build complete. Bundles available in src/static/v2/dist"

