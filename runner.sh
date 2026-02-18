#!/usr/bin/env bash
set -euo pipefail

###############################################
# Claude Code Monorepo Runner
# Preconfigured for:
# - Node + TypeScript
# - Fastify backend
# - React Native mobile
# - Shared TS package
# - Vitest + ESLint + tsc
###############################################

PROJECT_ROOT="$(pwd)"
LOG_DIR="$PROJECT_ROOT/.runner_logs"
STATE_FILE="$LOG_DIR/state.json"

mkdir -p "$LOG_DIR"

###############################################
# PRECONFIGURED COMMANDS (BASED ON YOUR STACK)
###############################################

# Root workspace commands
ROOT_INSTALL="npm install"
ROOT_LINT="npm run lint"
ROOT_TYPECHECK="npm run typecheck"
ROOT_TEST="npm run test"

# Backend
BACKEND_DIR="apps/backend"
BACKEND_LINT="cd $BACKEND_DIR && npm run lint"
BACKEND_TYPECHECK="cd $BACKEND_DIR && npm run typecheck"
BACKEND_TEST="cd $BACKEND_DIR && npm run test"

# Shared
SHARED_DIR="packages/shared"
SHARED_LINT="cd $SHARED_DIR && npm run lint"
SHARED_TYPECHECK="cd $SHARED_DIR && npm run typecheck"
SHARED_TEST="cd $SHARED_DIR && npm run test"

# Mobile (no full test yet, just typecheck + lint)
MOBILE_DIR="apps/mobile"
MOBILE_LINT="cd $MOBILE_DIR && npm run lint"
MOBILE_TYPECHECK="cd $MOBILE_DIR && npx tsc --noEmit"

###############################################
# POST CHECKS
###############################################

run_post_checks() {
  echo "🔎 Running monorepo validation..."

  eval "$ROOT_LINT"
  eval "$ROOT_TYPECHECK"
  eval "$ROOT_TEST"

  eval "$SHARED_LINT"
  eval "$SHARED_TYPECHECK"
  eval "$SHARED_TEST"

  eval "$BACKEND_LINT"
  eval "$BACKEND_TYPECHECK"
  eval "$BACKEND_TEST"

  eval "$MOBILE_LINT"
  eval "$MOBILE_TYPECHECK"

  echo "✅ All checks passed."
}

###############################################
# STATE TRACKING
###############################################

get_last_step() {
  if [[ -f "$STATE_FILE" ]]; then
    grep -o '"last_step":[0-9]*' "$STATE_FILE" | grep -o '[0-9]*'
  else
    echo 0
  fi
}

set_last_step() {
  echo "{\"last_step\":$1}" > "$STATE_FILE"
}

###############################################
# CLAUDE EDITS THIS BLOCK ONLY
###############################################
read -r -d '' CLAUDE_TASKS <<'EOF'
# Milestone 0+1: Full monorepo verification
npm run typecheck
cd packages/shared && npx vitest run && cd ../..
cd apps/backend && npx vitest run && cd ../..
npx eslint packages/shared/src/ apps/backend/src/
EOF
###############################################

main() {
  mapfile -t steps < <(printf "%s\n" "$CLAUDE_TASKS" | awk 'NF' | awk '!/^#/')

  if [[ ${#steps[@]} -eq 0 ]]; then
    echo "No tasks defined."
    exit 1
  fi

  last_done=$(get_last_step)
  echo "Last completed step: $last_done"

  idx=1
  for cmd in "${steps[@]}"; do
    if [[ $idx -le $last_done ]]; then
      echo "Skipping step $idx"
      idx=$((idx+1))
      continue
    fi

    echo "▶ STEP $idx: $cmd"
    if eval "$cmd"; then
      echo "Step $idx succeeded"
      run_post_checks
      set_last_step "$idx"
    else
      echo "❌ Step $idx failed"
      exit 1
    fi

    idx=$((idx+1))
  done

  echo "🎉 All tasks completed."
}

main