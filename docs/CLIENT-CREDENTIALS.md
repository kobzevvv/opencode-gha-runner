# Isolated gateway client credentials

The gateway keeps `WORKER_TOKEN` as its existing primary credential and retains the
Telegram sandbox credential. Additional clients use independent Cloudflare Worker secrets
named `WORKER_CLIENT_TOKEN_<CLIENT_ID>`, for example
`WORKER_CLIENT_TOKEN_SANDBOX3_AGENT_API`. The suffix becomes a stable client identity in
the gateway run record. Runs, status/result access, cancellation, and result callbacks stay
scoped to that identity.

Add or remove one named secret without reading, replacing, or redeploying the other secrets:

```sh
npx wrangler secret put WORKER_CLIENT_TOKEN_SANDBOX3_AGENT_API --config wrangler.toml --env sandbox
npx wrangler secret delete WORKER_CLIENT_TOKEN_SANDBOX3_AGENT_API --config wrangler.toml --env sandbox
```

Named client values must be at least 24 characters and unique from every other gateway
credential. Generate them with a cryptographic random source. Never put a value in `vars`,
workflow inputs, a command argument, or a checked-in file. A caller's token belongs only in
that caller's secret store. Revocation blocks new requests and access to that client's runs;
an already running job may no longer be able to post its final callback.

The sandbox3 Agent API integration uses
`scripts/provision-gha-client-credential.mjs` in the `trained-assist/ai-agent-runner`
repository. It creates a fresh value and installs it in the gateway sandbox, the matching
Runner API sandbox, and the corresponding GitHub Actions environment secret. It preflights
all targets to avoid overwriting, verifies Bearer authentication with an unknown-run status
probe, suppresses credential values from output, and removes newly created copies if a later
step fails. Production gateway credentials are not provisioned by that script.
