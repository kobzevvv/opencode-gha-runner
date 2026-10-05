#!/usr/bin/env bash
# Провижн репозитория кольца: один workflow + секрет + переменные.
#
# Репозиторию кольца нужен ровно один файл — `run-agent.yml` из этого каталога. Он
# тонкий: код раннера чекаутится из `opencode-gha-runner`, поэтому кольцо — это места
# запуска, а не форки раннера, и исправление в раннере доезжает до всех сразу.
#
# Запуск (нужен `gh`, авторизованный с правом `workflow` на целевые репозитории):
#
#   ./ring/provision.sh \
#     --gateway https://opencode-gha-runner-gateway.skillset-apply.workers.dev \
#     --artifacts-token ghp_… \
#     llm-tests/llm-tests personalexperiments/tests typeform-tests/typeform-tests
#
# `--artifacts-token` — то, чем джоба клонирует репозиторий пользователя и пушит в него
# артефакты (`contents: write`). Токен берётся из текущей авторизации `gh`, в argv не
# передаётся: argv виден в `ps`.
#
# Идемпотентен: повторный запуск перезапишет workflow и переменные.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKFLOW="$HERE/run-agent.yml"
GATEWAY=""; ARTIFACTS_TOKEN=""; LOG_UPLOAD="local"; GCS_BUCKET=""; AGENT_ARGS="--pure -m ladder/free"
REPOS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --gateway) GATEWAY="$2"; shift 2 ;;
    --artifacts-token) ARTIFACTS_TOKEN="$2"; shift 2 ;;
    --log-upload) LOG_UPLOAD="$2"; shift 2 ;;
    --gcs-bucket) GCS_BUCKET="$2"; shift 2 ;;
    --agent-args) AGENT_ARGS="$2"; shift 2 ;;
    --*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) REPOS+=("$1"); shift ;;
  esac
done

[ -n "$GATEWAY" ] || { echo "--gateway is required" >&2; exit 2; }
[ "${#REPOS[@]}" -gt 0 ] || { echo "нужен хотя бы один репозиторий owner/name" >&2; exit 2; }
[ -f "$WORKFLOW" ] || { echo "нет $WORKFLOW" >&2; exit 2; }

CONTENT="$(base64 < "$WORKFLOW" | tr -d '\n')"
fail=0

for repo in "${REPOS[@]}"; do
  echo "$repo"
  sha="$(gh api "repos/$repo/contents/.github/workflows/run-agent.yml" --jq '.sha' 2>/dev/null || true)"
  body="$(CONTENT="$CONTENT" SHA="$sha" python3 -c '
import json, os
b = {"message": "ci: run-agent для кольца (код раннера из opencode-gha-runner)", "content": os.environ["CONTENT"]}
if os.environ.get("SHA"): b["sha"] = os.environ["SHA"]
print(json.dumps(b))
')"
  if echo "$body" | gh api --method PUT "repos/$repo/contents/.github/workflows/run-agent.yml" --input - --jq '"  workflow  " + .commit.sha[0:8]' 2>&1 | tail -1; then :; else fail=1; continue; fi

  gh secret set ARTIFACTS_TOKEN --repo "$repo" --body "${ARTIFACTS_TOKEN:-$(gh auth token)}" >/dev/null && echo "  secret    ARTIFACTS_TOKEN"
  gh variable set GATEWAY_URL --repo "$repo" --body "$GATEWAY" >/dev/null
  gh variable set LOG_UPLOAD --repo "$repo" --body "$LOG_UPLOAD" >/dev/null
  gh variable set AGENT_ARGS --repo "$repo" --body "$AGENT_ARGS" >/dev/null
  [ -n "$GCS_BUCKET" ] && gh variable set GCS_LOG_BUCKET --repo "$repo" --body "$GCS_BUCKET" >/dev/null
  echo "  variables GATEWAY_URL, LOG_UPLOAD, AGENT_ARGS${GCS_BUCKET:+, GCS_LOG_BUCKET}"
done

exit $fail
