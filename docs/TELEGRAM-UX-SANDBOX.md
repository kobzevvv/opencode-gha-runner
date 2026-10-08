# CP Telegram UX Runner sandbox

This configuration is for a separate Cloudflare Worker and a dedicated KV
namespace. It must not be replaced with the primary `wrangler.toml`: that worker
already serves the main API.

## Resources

- Worker: `opencode-gha-runner-telegram-ux-sandbox`
- KV binding `RUNS`: `ef2ef198077946ac8a8dc0721aff4e08`
- Public base URL: `https://opencode-gha-runner-telegram-ux-sandbox.skillset-apply.workers.dev`
- Private Actions repository: `vovalikessmoothy-png/opencode-gha-runner-telegram-ux-sandbox`
- Private task/output fixture: `vovalikessmoothy-png/cp-telegram-ux-runner-sandbox`
- Wrangler config: `wrangler.telegram-ux-sandbox.toml`

The KV namespace was created in the trained-assist Cloudflare test account on
2026-10-08. The Worker has not been deployed yet.

## Required credentials

Provision secrets only on this Worker, after the code is merged and reviewed:

- `WORKER_TOKEN`: a new random credential for the isolated Worker. The disposable
  `trained-assist/ai-agent-runner` API uses the same value as
  `EXTERNAL_WORKER_TOKEN` when it calls this Worker.
- `GITHUB_TOKEN`: a fine-grained token limited to the selected Runner dispatch
  repository, with Actions read/write for dispatch, status lookup, and cancel.

`WORKER_TOKEN_TELEGRAM_UX` is an optional second gateway credential; CP does not
call this Worker directly, so do not pair it with CP's
`RUNNER_API_KEY_TELEGRAM_UX`. CP authenticates to the Serverless Agent API, which
then calls this Worker with `EXTERNAL_WORKER_TOKEN`.

Do not copy the primary Worker's `WORKER_TOKEN`, `GITHUB_TOKEN`, or `RING_TARGETS`.
Keep `RING_TARGETS` unset so this sandbox uses the single private execution repo
configured in `[vars]`.

The private GHA workflow repository has sandbox-only `GATEWAY_URL` and
`LOG_UPLOAD=local` variables. Its `ARTIFACTS_TOKEN` must be a fine-grained token
limited to the private task/output fixture above; do not copy the primary workflow
repo's publication secret or point at production artifacts/profile data. The gateway
`GITHUB_TOKEN` must be separately limited to Actions read/write on the private
workflow repository. Do not grant either token access to unrelated repositories.

## Deploy after credentials and API sandbox exist

```sh
npm ci
npm run verify
npm run build
npx wrangler deploy --config wrangler.telegram-ux-sandbox.toml
```

Configure the isolated Serverless Agent API with this Worker URL and matching
`EXTERNAL_WORKER_TOKEN`; the API key is a separate credential. CP sandbox
`RUNNER_API_URL` must point to that API endpoint, and `RUNNER_API_KEY_TELEGRAM_UX`
must be registered there for the Telegram UX principal. Verify health and profile
readiness, run one synthetic task, inspect its terminal callback and logs, then
reconcile task/run state. This setup is not an end-to-end acceptance until the
scenario evidence is recorded in architecture issue #190.
