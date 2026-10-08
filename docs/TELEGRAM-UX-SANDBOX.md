# CP Telegram UX Runner sandbox

This configuration is for a separate Cloudflare Worker and a dedicated KV
namespace. It must not be replaced with the primary `wrangler.toml`: that worker
already serves the main API.

## Resources

- Worker: `opencode-gha-runner-telegram-ux-sandbox`
- KV binding `RUNS`: `ef2ef198077946ac8a8dc0721aff4e08`
- Public base URL: `https://opencode-gha-runner-telegram-ux-sandbox.skillset-apply.workers.dev`
- Wrangler config: `wrangler.telegram-ux-sandbox.toml`

The KV namespace was created in the trained-assist Cloudflare test account on
2026-10-08. The Worker has not been deployed yet.

## Required credentials

Provision secrets only on this Worker, after the code is merged and reviewed:

- `WORKER_TOKEN`: a new random primary credential for this isolated Worker.
- `WORKER_TOKEN_TELEGRAM_UX`: a different random credential; provision the same
  value as CP sandbox secret `RUNNER_API_KEY_TELEGRAM_UX`.
- `GITHUB_TOKEN`: a fine-grained token limited to the selected Runner dispatch
  repository, with Actions read/write for dispatch, status lookup, and cancel.

Do not copy the primary Worker's `WORKER_TOKEN`, `GITHUB_TOKEN`, or `RING_TARGETS`.
Keep `RING_TARGETS` unset so this sandbox uses the single repository configured
in `[vars]`.

The GHA workflow repository also needs a disposable test configuration: its
workflow variables and `ARTIFACTS_TOKEN` are repository-scoped. Do not point this
Worker at production artifacts, profile data, or a shared publication credential.
The current dispatch workflow defaults log upload to GCS; set up an isolated test
bucket/WIF or a sandbox-only workflow configured for local logs before executing a
real Run.

## Deploy after credentials and workflow fixture exist

```sh
npm ci
npm run verify
npm run build
npx wrangler deploy --config wrangler.telegram-ux-sandbox.toml
```

Then set CP sandbox `RUNNER_API_URL` to the Worker URL and provision
`RUNNER_API_KEY_TELEGRAM_UX`. Verify health and profile readiness, run one
synthetic task, inspect its terminal callback and logs, then reconcile task/run
state. This setup is not an end-to-end acceptance until the scenario evidence is
recorded in architecture issue #190.
