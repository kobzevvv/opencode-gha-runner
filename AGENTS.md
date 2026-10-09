# Native worker environment contract

Use an isolated branch and worktree; preserve existing changes and open PRs.
Never print credentials, user prompts, model answers or raw dependency failures.
Do not call retired GCP services.

## Local and sandbox

`npm ci && npm run verify` builds and tests the real gateway/runner with local
fixtures. This does not prove a GitHub Actions agent or live model execution.
The declared Telegram UX gateway is configured separately by
`wrangler.telegram-ux-sandbox.toml`, with its own RUNS namespace and worker
credential. Reuse the existing Runner API and native gateway; do not create a
second launcher. Live checks must have a unique run ID, a bounded agent timeout,
output/log caps and a verified free model. Reconcile accepted or unknown runs
before repeating. Preserve other runs, credentials and mutable state.

## Promotion

Reviewed main changes pass `.github/workflows/ci.yml`. Existing native jobs
checkout this runner repository; changing runner code does not authorize edits
to other repositories' workflow variables or secrets. Gateway deployment is a
separate fixed-target operation and requires verified source/account/namespace.
Architecture issue #236 authorizes repairing this existing test chain through
reviewed PRs. No new paid resources or production deployments are authorized.
Public health and local mocks are not full Telegram acceptance evidence.

## Fresh sandbox3

`wrangler.sandbox3.jsonc` declares the separate native gateway and RUNS namespace
for `integration-sandbox3-v1`. Preserve the existing component gateway, its ref,
credentials and runs. Sandbox3 reuses the native launcher through
`run-agent-sandbox3.yml`: free ladder only, 180-second agent limit, 1 MiB output
and log limits, a separate Unix identity, serialized jobs and a 10-minute job ceiling. A signed profile
snapshot and run-scoped saveback capability are required before admission.
This does not establish a filesystem quota or full Telegram acceptance.
Profile object materialization/saveback uses the existing GCS_PROFILE_BUCKET
and GCS_WORKLOAD_PROVIDER/GCS_SERVICE_ACCOUNT configuration. Only the trusted
job receives WIF credentials; the isolated agent's environment does not receive
them. Session logs remain local. Preserve other profiles and object prefixes.

Deploy reviewed main using `deploy-sandbox3.yml` and environment
`native-sandbox3`. Its CF_API_TOKEN, SANDBOX3_WORKER_TOKEN and
SANDBOX3_GATEWAY_GITHUB_TOKEN are private deployment credentials, never agent
environment values. The workflow verifies the existing account, uses an
immutable runtime branch and checks source/policy plus anonymous rejection.
