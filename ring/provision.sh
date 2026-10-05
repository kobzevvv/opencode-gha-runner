#!/usr/bin/env bash
# Провижн репозитория кольца: workflow + секрет + переменные.
#
# Репозиторию кольца нужен ровно один файл — workflow, имя которого совпадает с именем
# репозитория. Код раннера он не хранит: чекаутит `opencode-gha-runner`. Поэтому кольцо —
# это места запуска, а не форки раннера, и исправление в раннере доезжает до всех сразу.
#
# Имя workflow и job подставляется из имени репозитория, чтобы в списке Actions не
# светилось имя нашего раннера: кольцо выглядит как обычные репозитории компании.
#
# Запуск (токен с правом `workflow` на целевые репозитории):
#
#   ./ring/provision.sh \
#     --token ghp_… \
#     --gateway https://opencode-gha-runner-gateway.skillset-apply.workers.dev \
#     llm-tests/agent-run personalexperiments/agent-run
#
# Идемпотентен: повторный запуск перезапишет workflow и переменные.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$HERE/run-agent.yml"
GATEWAY=""; TOKEN=""; LOG_UPLOAD="local"; GCS_BUCKET=""; AGENT_ARGS="--pure -m ladder/free"
REPOS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --gateway) GATEWAY="$2"; shift 2 ;;
    --log-upload) LOG_UPLOAD="$2"; shift 2 ;;
    --gcs-bucket) GCS_BUCKET="$2"; shift 2 ;;
    --agent-args) AGENT_ARGS="$2"; shift 2 ;;
    --*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) REPOS+=("$1"); shift ;;
  esac
done

[ -n "$TOKEN" ] || { echo "--token is required" >&2; exit 2; }
[ -n "$GATEWAY" ] || { echo "--gateway is required (публичный адрес шлюза)" >&2; exit 2; }
[ -f "$TEMPLATE" ] || { echo "нет $TEMPLATE" >&2; exit 2; }
[ "${#REPOS[@]}" -gt 0 ] || { echo "нужен хотя бы один репозиторий owner/name" >&2; exit 2; }

# Кладёт файл в репозиторий. В пустом репозитории Contents API не создаёт промежуточные
# каталоги (404), поэтому сначала заводим ветку файлом в корне.
#
# `sha` обязателен при обновлении существующего файла, и его нельзя брать «как есть»:
# при 404 `gh api` печатает тело ошибки в stdout, и без проверки формы оно попадало
# в поле `sha` — GitHub отвечал 404 на сам запрос.
put_file() {
  local repo="$1" api_path="$2" content="$3" message="$4"
  local encoded sha body
  encoded="$(printf '%s' "$content" | base64 | tr -d '\n')"
  sha="$(gh api "repos/$repo/contents/$api_path" --jq '.sha' 2>/dev/null || true)"
  if ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$'; then
    sha=""
  fi
  body="$(CONTENT="$encoded" SHA="$sha" MSG="$message" python3 -c '
import json, os
b = {"message": os.environ["MSG"], "content": os.environ["CONTENT"]}
if os.environ.get("SHA"): b["sha"] = os.environ["SHA"]
print(json.dumps(b))
')"
  echo "$body" | gh api --method PUT "repos/$repo/contents/$api_path" --input - --jq '.commit.sha[0:8]'
}

fail=0
for repo in "${REPOS[@]}"; do
  echo "$repo"
  name="${repo##*/}"
  # Имя workflow и job — из имени репозитория, чтобы наше имя не светилось в Actions.
  content="$(sed "s/{{REPO_NAME}}/$name/g" "$TEMPLATE")"

  if put_file "$repo" "README.md" "Agent runs." "init"; then echo "  root      ok"; else fail=1; continue; fi
  if put_file "$repo" ".github/workflows/$name.yml" "$content" "ci: agent run workflow"; then echo "  workflow  $name.yml"; else fail=1; continue; fi

  gh secret set ARTIFACTS_TOKEN --repo "$repo" --body "$TOKEN" >/dev/null && echo "  secret    ARTIFACTS_TOKEN"
  gh variable set GATEWAY_URL --repo "$repo" --body "$GATEWAY" >/dev/null
  gh variable set LOG_UPLOAD --repo "$repo" --body "$LOG_UPLOAD" >/dev/null
  gh variable set AGENT_ARGS --repo "$repo" --body "$AGENT_ARGS" >/dev/null
  [ -n "$GCS_BUCKET" ] && gh variable set GCS_LOG_BUCKET --repo "$repo" --body "$GCS_BUCKET" >/dev/null
  echo "  variables GATEWAY_URL, LOG_UPLOAD, AGENT_ARGS${GCS_BUCKET:+, GCS_LOG_BUCKET}"
done

exit $fail
