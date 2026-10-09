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
