#!/usr/bin/env bash
# Runs lint, tests and build for whatever exists in the repo. Exits non-zero on failure.
# Output is trimmed so failures are readable without wasting tokens.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
run() {
  local name="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    echo "PASS  $name"
  else
    echo "FAIL  $name"; echo "$out" | tail -n 40; fail=1
  fi
}

if [ -f pnpm-workspace.yaml ]; then
  run "js lint"  pnpm -r --if-present lint
  run "js test"  pnpm -r --if-present test
  run "js build" pnpm -r --if-present build
fi

if [ -d services/chatbot-service ]; then
  (cd services/chatbot-service
   if command -v ruff >/dev/null 2>&1; then run "py lint" ruff check .; fi
   if command -v pytest >/dev/null 2>&1 && ls tests >/dev/null 2>&1; then run "py test" pytest -q; fi)
fi

if [ -f docker-compose.yml ]; then
  envf=.env; [ -f .env ] || envf=.env.example
  run "compose config" docker compose --env-file "$envf" config -q
fi

exit $fail
