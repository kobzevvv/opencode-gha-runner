# Isolated GHA executor sandbox for CP Telegram UX tests

This is an internal executor behind the existing Runner API. It is **not** a
Telegram endpoint and Control Plane must not call this Worker directly. The
request path stays:

```text
Telegram → Control Plane → ai-agent-runner Serverless API
          → this GHA gateway → private GitHub Actions workflow
```

The endpoint settings belong at different boundaries:

- CP `RUNNER_API_URL` points to the `ai-agent-runner` Serverless API.
- Runner API `EXTERNAL_WORKER_URL` points to this Worker; its
  `EXTERNAL_WORKER_TOKEN` matches this Worker's `WORKER_TOKEN`.
- The private Actions repository's `GATEWAY_URL` points back to this Worker so
  the job can claim its run and report the result. It is not the CP API URL.
- CP's `RUNNER_API_KEY_TELEGRAM_UX` authenticates CP to the Runner API. It is a
  separate credential and must not be reused as the gateway token.

This configuration is for a separate Cloudflare Worker and a dedicated KV
namespace. It must not be replaced with the primary `wrangler.toml`: that worker
already serves the main API.

## Resources

- Internal GHA gateway Worker: `opencode-gha-runner-telegram-ux-sandbox`
- KV binding `RUNS`: `ef2ef198077946ac8a8dc0721aff4e08`
- Public base URL: `https://opencode-gha-runner-telegram-ux-sandbox.skillset-apply.workers.dev`
- Private Actions repository: `vovalikessmoothy-png/opencode-gha-runner-telegram-ux-sandbox`
- Optional private task/output fixture: `vovalikessmoothy-png/cp-telegram-ux-runner-sandbox`
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
`LOG_UPLOAD=local` variables. For this profile saveback scenario, do **not** create
an `ARTIFACTS_TOKEN`: `profileWorkspace` runs download their signed snapshot and
upload changes through the Runner API's one-run saveback capability. They bypass
the normal GitHub clone/publish path, so no Contents token for the optional fixture
repository is needed. Keep the Actions secret unset.

The gateway still needs a `GITHUB_TOKEN` limited to Actions read/write on the
private workflow repository so it can dispatch, inspect, and cancel jobs. Do not
grant it access to unrelated repositories or copy the primary gateway token.
Ordinary non-profile runs that publish outputs to another GitHub repository use a
separate publication credential; that flow is outside this profile acceptance.

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
