#!/usr/bin/env bash
# Start the voice bridge in the foreground (Ctrl-C to stop). Settings come from .env.
set -euo pipefail
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || { echo "Run ./setup.sh first." >&2; exit 1; }
exec .venv/bin/python app.py
