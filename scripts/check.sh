#!/usr/bin/env bash
# Runs lint, tests and build for whatever exists in the repo. Exits non-zero on failure.
# Output is trimmed so failures are readable without wasting tokens.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

# Only one check run at a time. The integration tests share a scratch Redis database and a scratch Postgres and flush them, so
# two runs at once (the Stop hook and a reviewer, say) would corrupt each other. This uses a real operating-system file lock:
# it is released the instant the owning process ends, however it ends (even kill -9), so there is never a stale lock to clean up
# and no process-id guessing. Waits up to 15 minutes, then fails (it never runs without the lock).
LOCKFILE="$(git rev-parse --git-dir 2>/dev/null || echo .git)/authentix-check.lock"
exec 9>"$LOCKFILE"
perl -MFcntl=:flock -e 'alarm 900; open(my $fh, ">&=", 9) or die "fd 9: $!"; flock($fh, LOCK_EX) or die "flock: $!";' \
  || { echo "FAIL  could not take the check lock (another run held it for 15 minutes?)"; exit 1; }

# Passwords for the dev databases live in .env (git-ignored). Load them so the integration tests can find the databases.
if [ -f .env ]; then set -a; . ./.env; set +a; fi
run() {
  local name="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    echo "PASS  $name"
  else
    echo "FAIL  $name"; echo "$out" | tail -n 40; fail=1
  fi
}

# Integration tests need the dev Postgres (docker compose publishes it on localhost:5432).
if [ -f .env ] && (exec 3<>/dev/tcp/127.0.0.1/5432) 2>/dev/null; then
  set -a; . ./.env; set +a
  export TEST_PG_URL="postgres://${POSTGRES_USER:-authentix}:${POSTGRES_PASSWORD}@127.0.0.1:5432/postgres"
  # Logical DB 15 is scratch space: the tests flush it, so the dev data in DB 0 is never touched.
  if (exec 3<>/dev/tcp/127.0.0.1/6379) 2>/dev/null; then export TEST_REDIS_URL="redis://127.0.0.1:6379/15"; fi
fi

if [ -f pnpm-workspace.yaml ]; then
  run "js lint"  pnpm -r --if-present lint
  run "js test"  pnpm -r --if-present test
  run "js build" pnpm -r --if-present build
fi

if [ -d services/chatbot-service ]; then
  # The Python service has its own virtualenv (created on first run, refreshed only when requirements change).
  # If it cannot be set up, that is a FAILURE, never a silent skip.
  run "py setup" scripts/py-venv.sh
  if [ -x services/chatbot-service/.venv/bin/pytest ]; then
    # Logical Postgres on 5433 is the chatbot's own pgvector container (docker compose publishes it for tests).
    if (exec 3<>/dev/tcp/127.0.0.1/5433) 2>/dev/null && [ -n "${POSTGRES_PASSWORD:-}" ]; then
      export TEST_VECTOR_PG_URL="postgresql://${POSTGRES_USER:-authentix}:${POSTGRES_PASSWORD}@127.0.0.1:5433/postgres"
    else
      # Never skip quietly: say so, so a PASS can't be mistaken for "the database tests ran".
      echo "SKIP  py database tests (chatbot-db is not reachable on 127.0.0.1:5433, or POSTGRES_PASSWORD is not set)"
    fi
    run "py lint" bash -c 'cd services/chatbot-service && .venv/bin/ruff check .'
    run "py test" bash -c 'cd services/chatbot-service && .venv/bin/pytest -q'
  fi
fi

if [ -f docker-compose.yml ]; then
  envf=.env; [ -f .env ] || envf=.env.example
  run "compose config" docker compose --env-file "$envf" config -q
fi

exit $fail
