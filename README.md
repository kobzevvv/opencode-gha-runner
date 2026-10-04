# opencode-gha-runner

Внешний воркер Serverless Agent API: принимает `POST /v1/launch`, поднимает одноразовую
джобу в GitHub Actions, запускает в ней агента opencode и возвращает результат в формате
`LaunchResult`.

Контракт — issue #73 в [`trained-assist/ai-agent-runner`](https://github.com/trained-assist/ai-agent-runner/issues/73).
Движок в нашем API: `engine.name = "dynamic-ip-azure-agent-run"`, адаптер `DynamicIpAzureAdapter`.

## Схема

```
наш API (ai-agent-runner)
  │  POST /v1/launch            Authorization: Bearer WORKER_TOKEN
  ▼
шлюз (Cloudflare Worker / node:http)          ← этот репозиторий, src/gateway
  │  хранит LaunchRequest, диспатчит workflow с ОДНИМ claim-токеном
  ▼
GitHub Actions: .github/workflows/run-agent.yml
  │  POST /v1/claim             Authorization: Bearer <claim_token>
  ▼  ← получает { spec, llmKey, reportToken }
создаёт per-run Unix-идентичность → клонирует repository.fullName
  → opencode run "<промпт>" под этой идентичностью, только с разрешённым env
  → артефакты коммитом в repository.fullName, лог в GCS
  │  POST /v1/runs/{runId}/result
  ▼
наш API: GET /v1/runs/{runId} → LaunchResult
```

## Почему ключ LLM не едет в `workflow_dispatch`

`workflow_dispatch` публичного репозитория показывает `inputs` в метаданных прогона и в
логах. Ключ или промпт там — утечка в мир. Поэтому в inputs ровно два значения:
`run_id` и одноразовый `claim_token`; всё остальное джоба забирает у шлюза обменом
токена на `{ spec, llmKey, reportToken }`, и токен гасится после первого claim'а.
Тест `в dispatch ушел только claim-токен` в `test/gateway.test.ts` это фиксирует.

## Эндпоинты

| Метод | Путь | Авторизация | Ответ |
|---|---|---|---|
| `POST` | `/v1/launch` | `Bearer WORKER_TOKEN` | `202` `{runId, status:"started", githubRunId, githubRunUrl, pollUrl}` |
| `GET` | `/v1/runs/{runId}` | `Bearer WORKER_TOKEN` | `202` пока нет результата, `200` с `LaunchResult` |
| `POST` | `/v1/runs/{runId}/cancel` | `Bearer WORKER_TOKEN` | `200` `{runId, status, cancelled, reason}` |
| `POST` | `/v1/claim` | `Bearer <claim_token>` | `200` `{runId, spec, llmKey, llmKeyEnvName, reportToken, reportUrl, agentBinary}` |
| `POST` | `/v1/runs/{runId}/result` | `Bearer <report_token>` | `200` `{runId, status:"accepted"}` |
| `GET` | `/healthz` | — | `200` `{ok, engine, repo, workflow}` |

Коды отказа — в `failure.code`: `AGENT_BINARY_MISSING`, `AGENT_STARTUP_FAILED`,
`AGENT_TIMEOUT`, `AGENT_CRASH`, `AGENT_NONZERO_EXIT`, `WORKER_INTERNAL`,
`ISOLATION_UNSUPPORTED`.

## Локальный запуск и приёмка

```bash
npm ci
npm run verify     # typecheck + 74 теста + сквозной прогон контракта по HTTP
npm run dev        # шлюз на :8787 — нужен, чтобы дёргать руками
npm run smoke      # поднимает шлюз, прогоняет launch → poll → claim → result → cancel
```

`npm run smoke` ничего не деплоит и не обращается к GitHub: клиент замокан, весь цикл идёт
по настоящему HTTP через `node:http`-транспорт.

Пример ручного вызова:

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/launch \
  -H "Authorization: Bearer $WORKER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "runId": "run_local_0001",
    "jobId": "job-1", "userTaskId": "task-1", "profileId": "profile-1",
    "conversationId": "conv-1", "operationId": "op-1", "ownerGeneration": 1,
    "engine": { "name": "dynamic-ip-azure-agent-run", "adapterVersion": "1" },
    "input": { "inlinePrompt": "Напиши report.md" },
    "cwd": "/home/runner/work/repo/repo",
    "envAllowlist": ["PATH", "HOME", "LLM_LADDER_TOKEN"],
    "env": { "PATH": "/usr/bin", "HOME": "/home/runner" },
    "limits": { "timeoutMs": 300000, "maxOutputBytes": 1048576, "maxLogBytes": 1048576 },
    "repository": { "fullName": "vovalikessmoothy-png/opencode-gha-runner" },
    "isolation": { "mode": "per_run_unix_identity" },
    "outputs": [{ "path": "report.md", "name": "report.md", "mime": "text/markdown" }],
    "credentials": { "llmKey": "…" }
  }'
```

## Что нужно настроить в репозитории

**Actions → General → Workflow permissions → Read and write**: не требуется, джоба пишет
только через `ARTIFACTS_TOKEN`.

| Что | Где | Зачем |
|---|---|---|
| `ARTIFACTS_TOKEN` (secret) | Actions → Secrets | клон `repository.fullName` и пуш артефактов; fine-grained PAT с `contents: write` |
| `GATEWAY_URL` (variable) | Actions → Variables | публичный адрес шлюза |
| `LOG_UPLOAD` (variable) | Actions → Variables | `gcs` (по умолчанию) или `local` для приёмки без бакета |
| `GCS_LOG_BUCKET` (variable) | Actions → Variables | бакет для логов сессии |
| `GCS_WORKLOAD_PROVIDER`, `GCS_SERVICE_ACCOUNT` (env) | Environments | Workload Identity Federation для `google-github-actions/auth` |
| `AGENT_ARGS` (variable) | Actions → Variables | доп. флаги агенту, например `-m ladder/free` |

`GITHUB_TOKEN` джобы для этого не годится: он ограничен одним репозиторием, а артефакты
кладутся в репозиторий пользователя.

## Деплой шлюза

```bash
npx wrangler kv namespace create RUNS     # вписать id в wrangler.toml
npx wrangler secret put WORKER_TOKEN      # общий секрет с нашим API
npx wrangler secret put GITHUB_TOKEN      # токен для workflow_dispatch и отмены
npx wrangler deploy
```

`PUBLIC_BASE_URL` обязан совпадать с публичным адресом шлюза: он попадает в `pollUrl`
и `reportUrl`, и джоба идёт именно туда.

Для GCS понадобится бакет и WIF-провайдер; лог кладётся `publicRead`, иначе ссылка из
`logUrl` отдаёт 403.

## Отклонения от ТЗ и от issue #73

Контракт в issue помечен как драфт, а GHA накладывает ограничения, которых в нём нет.
Каждое отклонение — осознанное:

1. **`launch` отвечает `202 started`, а не финальным `LaunchResult`.** Холодный старт
   GHA-джобы — 15–45 с (замерено в `docs/GITHUB-ACTIONS-CAPABILITY.md` нашего API), бывает
   очередь. Финальный результат наш API забирает через `GET /v1/runs/{runId}`. Иначе
   `launch` упирался бы в сетевой таймаут клиента.
2. **Клонирует воркер, а не наш API.** ТЗ и issue #73 говорят «репозиторий уже склонирован»,
   но у GHA-джобы нет общей файловой системы с нашим API, а `cwd` в HTTP-запросе не
   передаёт байты. `cwd` трактуется как путь workspace внутри раннера.
3. **`credentials.llmKey` — новое поле.** В issue #73 ключа в `LaunchRequest` нет; там
   предлагалось класть его в `env` под именем из `envAllowlist`. Отдельное поле нужно,
   чтобы preflight-отказ «ключ не пришёл» не выглядел как падение агента на модели.
4. **`AGENT_NONZERO_EXIT` — новый код отказа.** В issue #73 перечислены только отказы
   «процесс не запустился». Ран может и запуститься, и упасть на реальной работе; вешать
   на это `AGENT_STARTUP_FAILED` нельзя — наш API прочитал бы `retryable: true` и
   повторил бы заведомо бесполезно.
5. **`isolation.mode: per_run_unix_identity` поддержан, но не бесплатно.** Нужен
   passwordless sudo. На GitHub-hosted раннере он есть, поэтому граница ставится по-настоящему
   (`useradd` + `chown` + `setpriv`). Если sudo нет — воркер не имитирует изоляцию, а
   отказывается с `ISOLATION_UNSUPPORTED` / `failureClass: preflight`.
6. **Артефакты кладутся в ветку `opencode-gha-runner/<runId>`**, а не в дефолтную. Имя
   детерминированное, наш API может вычислить его сам; история пользователя не трогается.
   `cwd` не используется как префикс — в нём могут быть символы, недопустимые в ветке.

## Границы, которые стоит знать

- **GHA не даёт входящих портов.** Шлюз — единственный держатель состояния, поэтому
  `LaunchRequest` живёт в KV между `launch` и `result` (TTL 6 ч) и вычищается оттуда
  сразу после результата.
- **Холодный старт 15–45 с.** Для realtime это не подходит; для батчей и ранов
  продолжительностью от минуты — да.
- **Потолок памяти ~15 GiB, CPU только.** Задачи тяжелее CPU-инференса в GHA не идут.
- **Джоба обязана завершиться.** Долгоживущий сервис в GHA невозможен: job живёт до 6 ч.
- **`env -i` + `setpriv`** означают, что агент не видит ни `GITHUB_TOKEN` джобы, ни
  ничего из окружения хоста. Всё, что агенту нужно, приходит из `envAllowlist` плюс
  `llmKey` под своим именем.
- **Значения из `env`, которых нет в `envAllowlist`, до агента не доезжают** — даже если
  наш API их прислал. Это проверяется тестом.

## Структура

| Путь | Что |
|---|---|
| `src/contracts.ts` | типы и валидация `LaunchRequest` / `LaunchResult`, redaction |
| `src/claim.ts` | протокол claim'а: одноразовые токены вместо ключа в `inputs` |
| `src/gateway/app.ts` | HTTP-роутинг `Request → Response`, общий для Worker и Node |
| `src/gateway/store.ts` | раны в памяти и в Cloudflare KV |
| `src/gateway/github.ts` | `workflow_dispatch`, поиск `run_id`, отмена |
| `src/gateway/node-server.ts` | `node:http`-транспорт для локального прогона |
| `src/worker.ts` | Cloudflare Worker: тот же gateway + KV binding |
| `src/runner/main.ts` | джоба: claim → изоляция → клон → агент → артефакты → лог → отчёт |
| `src/runner/identity.ts` | `per_run_unix_identity`: `useradd`, `setpriv`, `env -i` |
| `src/runner/exec.ts` | таймаут с убийством дерева, капы вывода, сбор env |
| `src/runner/artifacts.ts` | сбор выходов с проверкой выхода из workspace, пуш в репозиторий |
| `src/runner/logs.ts` | лог сессии в GCS, наружу только ссылка |
| `.github/workflows/run-agent.yml` | джоба: сборка, тесты, opencode, запуск |
