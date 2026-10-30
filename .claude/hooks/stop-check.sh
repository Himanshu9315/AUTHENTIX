#!/usr/bin/env bash
# Stop hook: when Claude is about to finish, run the checks if code changed.
# Exit 2 sends the failure output back to Claude so it keeps working (the loop).
input=$(cat)

# Prevent an endless loop: if this hook already forced a continuation, let it stop.
echo "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true' && exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# Skip when nothing changed (e.g. Claude only answered a question).
if git rev-parse --git-dir >/dev/null 2>&1 \
   && git diff --quiet && git diff --cached --quiet \
   && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  exit 0
fi

[ -x scripts/check.sh ] || exit 0
out=$(scripts/check.sh 2>&1) && exit 0

echo "Checks failed. Fix these, then re-run scripts/check.sh until it passes:" >&2
echo "$out" >&2
exit 2
