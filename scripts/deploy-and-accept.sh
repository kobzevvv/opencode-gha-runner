#!/usr/bin/env bash
#
# Деплой воркера и приёмка публикации артефактов.
#
# Скрипт закрывает одну связку: задеплоить шлюз и доказать, что артефакты рана доезжают
# в репозиторий задачи, а клиент получает адрес мержа, а не адрес ветки.
#
# Авторизация в Cloudflare — единственный шаг, который скрипт не может выполнить сам:
# OAuth-токен wrangler протухает, и обновление требует браузера. Скрипт это проверяет
# первым и говорит, что делать, вместо того чтобы падать в середине.
#
#   ./scripts/deploy-and-accept.sh              # деплой + приёмка
#   RUNS=8 ./scripts/deploy-and-accept.sh       # больше прогонов
#   SKIP_TESTS=1 ./scripts/deploy-and-accept.sh # без локальных тестов
#   AUTH_ONLY=1 ./scripts/deploy-and-accept.sh  # только проверить/поднять авторизацию
#
set -Eeuo pipefail

WORKER_DIR="${WORKER_DIR:-$HOME/Code/opencode-gha-runner-work}"
API_DIR="${API_DIR:-$HOME/Code/ai-agent-runner-work}"
STATE="${STATE:-$WORKER_DIR/.accept}"
RUNS="${RUNS:-3}"
API_PORT="${API_PORT:-8791}"
REPO="${REPO:-vovalikessmoothy-png/opencode-gha-runner}"
GATEWAY="${GATEWAY:-https://opencode-gha-runner-gateway.skillset-apply.workers.dev}"
LLM_KEY_SVC="${LLM_KEY_SVC:-LLM_LADDER_TOKEN}"
LLM_KEY_HOST="${LLM_KEY_HOST:-vm2}"

step() { printf '\n=== %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }

# ── 1. авторизация Cloudflare ────────────────────────────────────────────────
step "1/6 Авторизация Cloudflare"

# Токен из окружения wins: он не протухает и переживает перезапуск.
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  info "CLOUDFLARE_API_TOKEN задан в окружении"
else
  # OAuth-токен wrangler лежит вне репозитория и протухает. Проверяем его фактом,
  # а не наличием файла: expired-токен проходит проверку файла и падает на деплое.
  if npx --yes wrangler@3 --version >/dev/null 2>&1 && (cd "$WORKER_DIR" && npx wrangler whoami >/dev/null 2>&1); then
    info "OAuth-токен wrangler действителен"
  else
    cat >&2 <<'MSG'

  wrangler не авторизован: OAuth-токен протух (или его нет).
  Обновить одним из двух способов — и запусти скрипт снова:

    1) OAuth через браузер (откроется окно, нужно подтвердить):
         cd ~/Code/opencode-gha-runner-work && npx wrangler login

    2) API-токен Cloudflare (Workers Scripts: Edit, KV Storage: Edit):
         export CLOUDFLARE_API_TOKEN=…

MSG
    exit 1
  fi
fi

# ── 2. состояние репозитория ─────────────────────────────────────────────────
step "2/6 Состояние $WORKER_DIR"

[ -d "$WORKER_DIR" ] || die "нет каталога $WORKER_DIR (задай WORKER_DIR)"
cd "$WORKER_DIR"
git fetch -q origin
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
[ "$LOCAL" = "$REMOTE" ] || die "локальный HEAD разошёлся с origin/main:
  local  $LOCAL
  origin $REMOTE
  Сначала git checkout main && git pull"
info "HEAD = $LOCAL, совпадает с origin/main"

if [ -n "$(git status --porcelain)" ]; then
  die "рабочее дерево грязное — деплой соберётся не из того, что проверено:
$(git status --short)"
fi

# ── 3. локальные проверки ─────────────────────────────────────────────────────
step "3/6 Локальные проверки"

if [ "${SKIP_TESTS:-0}" = "1" ]; then
  info "SKIP_TESTS=1 — пропускаю"
else
  npm ci --silent
  npm run typecheck
  npm test 2>&1 | tail -6
fi
info "ok"

# ── 4. деплой ─────────────────────────────────────────────────────────────────
if [ "${AUTH_ONLY:-0}" = "1" ]; then
  step "4/6 AUTH_ONLY=1 — деплой пропущен"
else
  step "4/6 Деплой шлюза"
  npx wrangler deploy 2>&1 | tail -5
  info "проверяю, что шлюз жив"
  for _ in $(seq 1 10); do
    if curl -sS -m 10 "$GATEWAY/healthz" | grep -q '"ok":true'; then break; fi
    sleep 3
  done
  curl -sS -m 10 "$GATEWAY/healthz" | head -c 200; echo
  curl -sS -m 10 "$GATEWAY/healthz" | grep -q '"ok":true' || die "шлюз не отвечает после деплоя"
fi

# ── 5. поднять наше API ───────────────────────────────────────────────────────
step "5/6 Наше API (Serverless Agent API)"

[ -d "$API_DIR" ] || die "нет каталога $API_DIR (задай API_DIR)"
cd "$API_DIR"
[ -d node_modules ] || npm ci --silent
[ -d dist ] || npm run build >/dev/null 2>&1

mkdir -p "$STATE"
if [ ! -f "$STATE/api-key" ]; then
  KEY="ak_$(openssl rand -hex 24)"
  HASH="$(printf '%s' "$KEY" | shasum -a 256 | awk '{print $1}')"
  printf '{"schemaVersion":1,"principals":[{"keyHash":"%s","principalId":"accept","profileId":"profile-accept","scopes":["runs:read","runs:write"],"engines":["dynamic-ip-azure-agent-run"]}]}\n' "$HASH" > "$STATE/key-registry.json"
  printf '%s\n' "$KEY" > "$STATE/api-key"
  chmod 600 "$STATE/api-key" "$STATE/key-registry.json"
  info "создан новый API-ключ в $STATE"
fi
API_KEY="$(tr -d '[:space:]' < "$STATE/api-key")"

# Публичный адрес обязателен: джоба шлёт результат на resultUrl, и localhost из
# GitHub Actions недостижим. Туннель — единственный способ получить публичный адрес
# с машины разработчика.
PUBLIC_URL="${PUBLIC_URL:-}"
if [ -z "$PUBLIC_URL" ]; then
  if [ -f "$STATE/tunnel-url" ]; then
    CANDIDATE="$(cat "$STATE/tunnel-url")"
    if curl -sS -m 10 -o /dev/null "$CANDIDATE/healthz" 2>/dev/null; then
      PUBLIC_URL="$CANDIDATE"
      info "туннель из прошлого раза ещё жив: $PUBLIC_URL"
    fi
  fi
fi
if [ -z "$PUBLIC_URL" ]; then
  info "поднимаю cloudflared"
  (cd "$STATE" && nohup cloudflared tunnel --url "http://127.0.0.1:$API_PORT" --no-autoupdate > tunnel.log 2>&1 &)
  for _ in $(seq 1 30); do
    PUBLIC_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$STATE/tunnel.log" 2>/dev/null | head -1)"
    [ -n "$PUBLIC_URL" ] && break
    sleep 2
  done
  [ -n "$PUBLIC_URL" ] || die "туннель не поднялся, смотри $STATE/tunnel.log"
  printf '%s' "$PUBLIC_URL" > "$STATE/tunnel-url"
  info "туннель: $PUBLIC_URL"
fi

# Ключ LLM: берём с VM, где лежит реальный ключ кольца. В репозиторий он не попадает.
LLM_KEY="${LLM_KEY:-}"
if [ -z "$LLM_KEY" ]; then
  LLM_KEY="$(ssh -o ConnectTimeout=10 "$LLM_KEY_HOST" \
    "sudo grep -o 'LLM_LADDER_TOKEN\\\\\":\\\\\"[a-z0-9]*' /etc/agent-runner/integrator-v1-combined.env | head -1 | sed 's/.*\\\\\":\\\\\"//'" 2>/dev/null || true)"
fi
[ -n "$LLM_KEY" ] || die "не нашёл ключ LLM. Задай LLM_KEY=… вручную (нужен ключ кольца с доступом к ladder/free)"

# Токен публикации: права на репозиторий задачи. Без него джоба честно откажется
# ARTIFACTS_TOKEN_UNSET — это ожидаемое поведение, а не повод искать другой путь.
PUB_TOKEN="${PUBLICATION_TOKEN:-}"
if [ -z "$PUB_TOKEN" ]; then
  PUB_TOKEN="$(security find-generic-password -s "gh:github.com" -a "vovalikessmoothy-png" -w 2>/dev/null || true)"
fi
[ -n "$PUB_TOKEN" ] || die "нет токена публикации. Задай PUBLICATION_TOKEN=… (PAT с contents: write на $REPO)"

WRANGLER_KEY="${WRANGLER_KEY:-$(security find-generic-password -s WORKER_TOKEN -w 2>/dev/null || true)}"
[ -n "$WRANGLER_KEY" ] || die "нет WORKER_TOKEN в keychain (service WORKER_TOKEN)"

cat > "$STATE/api.env" <<ENV
AGENT_API_HOST=127.0.0.1
AGENT_API_PORT=$API_PORT
AGENT_API_KEY_REGISTRY=$STATE/key-registry.json
AGENT_API_PUBLIC_URL=$PUBLIC_URL
EXTERNAL_WORKER_URL=$GATEWAY
EXTERNAL_WORKER_TOKEN=$WRANGLER_KEY
EXTERNAL_WORKER_ENGINE=dynamic-ip-azure-agent-run
RUNNER_DEFAULT_REPO=$REPO
AGENT_API_ENV='{"$LLM_KEY_SVC":"$LLM_KEY"}'
ENV
chmod 600 "$STATE/api.env"

if curl -sS -m 5 -o /dev/null "http://127.0.0.1:$API_PORT/healthz" 2>/dev/null; then
  info "API уже слушает :$API_PORT — перезапускаю на свежем dist"
  lsof -tiTCP:"$API_PORT" -sTCP:LISTEN | xargs -r kill 2>/dev/null || true
  sleep 2
fi
set -a; . "$STATE/api.env"; set +a
(cd "$API_DIR" && nohup node dist/api/main.js > "$STATE/api.log" 2>&1 &)
for _ in $(seq 1 20); do
  curl -sS -m 5 -o /dev/null "http://127.0.0.1:$API_PORT/healthz" 2>/dev/null && break
  sleep 2
done
curl -sS -m 5 -o /dev/null "http://127.0.0.1:$API_PORT/healthz" 2>/dev/null || die "API не поднялся, смотри $STATE/api.log"
info "API на :$API_PORT, публичный адрес $PUBLIC_URL"

# ── 6. приёмка ────────────────────────────────────────────────────────────────
step "6/6 Приёмка: $RUNS прогонов, публикация в $REPO"

PASS=0; FAIL=0
for i in $(seq 1 "$RUNS"); do
  body="$(python3 - "$REPO" "$PUB_TOKEN" "$i" <<'PY'
import json, sys
repo, token, i = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
  "engine": {"name": "dynamic-ip-azure-agent-run", "adapterVersion": "1"},
  "limits": {"timeoutMs": 420000, "maxOutputBytes": 1048576, "maxLogBytes": 1048576},
  "envAllowlist": ["LLM_LADDER_TOKEN"],
  "repository": {"fullName": repo, "token": token},
  "outputs": [{"path": "report.md", "name": "report.md", "mime": "text/markdown"}],
  "input": {"inlinePrompt": f"Напиши report.md: одна строка о времени. Итерация {i}."},
}))
PY
)"
  receipt="$(curl -sS -m 60 -X POST "http://127.0.0.1:$API_PORT/v1/runs" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Idempotency-Key: accept-$(date +%s)-$i" \
    -H 'Content-Type: application/json' -d "$body")"
  RUN="$(printf '%s' "$receipt" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("runId",""))' 2>/dev/null || true)"
  if [ -z "$RUN" ]; then
    printf '  [%s] submit не прошёл: %s\n' "$i" "$receipt"; FAIL=$((FAIL+1)); continue
  fi

  STATE_=""
  for _ in $(seq 1 70); do
    STATE_="$(curl -sS -m 15 "http://127.0.0.1:$API_PORT/v1/runs/$RUN/status" -H "Authorization: Bearer $API_KEY" \
      | python3 -c 'import json,sys;print(json.load(sys.stdin).get("state",""))' 2>/dev/null || true)"
    case "$STATE_" in succeeded|failed|cancelled) break ;; esac
    sleep 10
  done

  printf '%s' "$RUN" > "$STATE/last-run-id"
  curl -sS -m 20 "http://127.0.0.1:$API_PORT/v1/runs/$RUN/artifacts" -H "Authorization: Bearer $API_KEY" > "$STATE/last-artifacts.json"
  curl -sS -m 20 "http://127.0.0.1:$API_PORT/v1/runs/$RUN/result" -H "Authorization: Bearer $API_KEY" > "$STATE/last-result.json"

  I="$i" RUN="$RUN" STATE="$STATE_" python3 - "$STATE" <<'PY'
import json, os, sys
state_dir = sys.argv[1]
res = json.load(open(f"{state_dir}/last-result.json"))
art = json.load(open(f"{state_dir}/last-artifacts.json"))
merge, branch, artifacts = art.get("mergeUrl", ""), art.get("branch", ""), art.get("artifacts", [])
outcome, reason = res.get("outcome"), res.get("exitReason")
problems = []
if outcome != "succeeded": problems.append(f"outcome={outcome}/{reason}")
if not artifacts: problems.append("артефактов нет")
if merge.startswith("https://github.com/") and "/compare/" not in merge:
    problems.append(f"mergeUrl не адрес мержа: {merge}")
label = "OK  " if not problems else "ХУЖЕ"
print(f"  [{label}] {os.environ['RUN']} outcome={outcome} артефактов={len(artifacts)} merge={'да' if '/compare/' in merge else 'НЕТ'}")
for p in problems: print(f"          ↳ {p}")
PY

  # Считаем по факту mergeUrl: это и есть предмет приёмки.
  if python3 -c "import json,sys;d=json.load(open('$STATE/last-artifacts.json'));sys.exit(0 if d.get('artifacts') and '/compare/' in d.get('mergeUrl','') else 1)" 2>/dev/null; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
  fi
done

step "Итог"
info "прошло: $PASS, не прошло: $FAIL"
info "последний ран: $(cat "$STATE/last-run-id" 2>/dev/null || echo —)"
info "артефакты рана: $STATE/last-artifacts.json"
[ "$FAIL" -eq 0 ] || die "приёмка не пройдена полностью: $FAIL из $RUNS"
info "приёмка пройдена"