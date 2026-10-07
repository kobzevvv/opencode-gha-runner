# Profile saveback validation

## Declared environment

`run-agent.yml` uses `runs-on: ubuntu-latest`. The repository does not configure a
self-hosted runner. GitHub-hosted `ubuntu-latest` jobs run on a fresh VM for each job;
the machine is decommissioned when the job finishes. See [GitHub-hosted runners](https://docs.github.com/en/actions/how-tos/manage-runners/github-hosted-runners/use-github-hosted-runners).
The workflow still creates a per-run Unix identity so agent processes and profile files
are isolated within the job.

There is currently no declared disposable end-to-end API/Worker environment for profile
saveback. The real GHA profile write/read-after-write path is therefore **not proven**.
Do not use a production API or profile as a substitute. The cross-repository sandbox gap
is tracked in [ai-agent-runner issue #173](https://github.com/trained-assist/ai-agent-runner/issues/173).

## Local validation

Run from a clean checkout with Node.js 20 or later:

```sh
npm ci
npm run typecheck
npm test
npm run smoke
```

The profile snapshot tests create temporary tar archives and directories under the OS
temporary directory. Test cleanup removes them automatically. The tests verify the
archive checksum, safe extraction, private archive permissions and cleanup, changed-file checksums,
sequential capability uploads, returned change manifest, and removal of snapshot
capabilities from completed Gateway state. `npm run smoke` exercises only the local
Gateway contract with fake GitHub and callback clients; it does not launch OpenCode or
call the remote API.

To inspect a failing local test, rerun its compiled file after `npm run build`, for
example:

```sh
node --test dist/test/profile-snapshot.test.js
node --test dist/test/gateway.test.js
```

No remote state is changed by these commands. Temporary test state is reset by the test
cleanup handlers.

## Live GHA acceptance, when a disposable sandbox exists

Use only a dedicated disposable test profile and the test API/Worker deployment. The
profile must contain no PII or secrets. Record the starting canonical revision, submit a
run that changes one allowlisted text file, and then verify:

1. The job claims the request and downloads the API-signed snapshot; snapshot checksum
   and the run's manifest artifact checksums validate.
2. No profile-repository GitHub token is present in workflow inputs or the agent process.
   Each changed file is uploaded sequentially to the API with the run-scoped saveback
   capability.
3. `LaunchResult.profileChanges` is returned only after every file upload succeeds.
   A failed upload reports failed persistence and does not authorize a partial publish
   or deletion.
4. The API publishes the profile update and a second run sees the new canonical
   revision. Verify file contents and SHA-256 at the API side.
5. Run another test with a rejected upload and verify the canonical profile remains at
   its prior revision.

Inspect the GHA job log and the authenticated Worker status/result endpoints, then check
the canonical profile revision through the test API. Never copy capability values or
signed snapshot URLs into logs or issue comments. After acceptance, restore the disposable
profile to the recorded starting revision and remove its test run records through the
test API's supported cleanup path. These live checks remain blocked until the isolated
API/Worker sandbox and reset procedure are available.
