#!/usr/bin/env bash
# Creates (or refreshes) the chatbot service's local virtualenv. Reinstalls only when the requirements files change.
set -euo pipefail
cd "$(dirname "$0")/../services/chatbot-service"
PY="$(command -v python3.12 || command -v python3.13 || command -v python3)"
stamp=".venv/.requirements.hash"
want="$(cat requirements.txt requirements-dev.txt | shasum -a 256 | cut -d' ' -f1)"
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$want" ]; then
  rm -rf .venv
  "$PY" -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -r requirements.txt -r requirements-dev.txt
  echo "$want" > "$stamp"
fi
