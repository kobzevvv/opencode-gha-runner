#!/usr/bin/env bash
set -euo pipefail

repo='trained-assist/ai-agent-runner'
release_tag="${WORKER_RELEASE_TAG:-}"
if [[ -z "$release_tag" ]]; then
  release_tag="$(gh release list --repo "$repo" --limit 100 \
    --json tagName,isLatest,isDraft,isPrerelease \
    --jq '[.[] | select(.isLatest == true and .isDraft == false and .isPrerelease == false) | select(.tagName | test("^vm-worker-v[0-9]+\\.[0-9]+\\.[0-9]+$"))] | if length == 1 then .[0].tagName else error("expected exactly one latest stable vm-worker release") end')"
fi
echo "Resolved OpenCode worker release: $release_tag"
archive_name='ai-agent-vm-worker-linux-x64.tar.gz'
signer_workflow="$repo/.github/workflows/vm-worker-release.yml"
tmp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

if [[ ! "$release_tag" =~ ^vm-worker-v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  echo 'WORKER_RELEASE_TAG must be an immutable vm-worker-vX.Y.Z tag' >&2
  exit 2
fi
expected_worker_version="${BASH_REMATCH[1]}"
if [[ -z "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]]; then
  echo 'GH_TOKEN or GITHUB_TOKEN is required to download and verify the release' >&2
  exit 2
fi

tmp="$(mktemp -d "$tmp_root/opencode-provision.XXXXXX")"
trap 'rm -rf -- "$tmp"' EXIT

gh release download "$release_tag" --repo "$repo" \
  --pattern "$archive_name" --pattern "$archive_name.sha256" --dir "$tmp"
(cd "$tmp" && sha256sum --check "$archive_name.sha256")
gh attestation verify "$tmp/$archive_name" --repo "$repo" \
  --signer-workflow "$signer_workflow" --source-ref "refs/tags/$release_tag" >/dev/null

tar -xOf "$tmp/$archive_name" ./dist/vm-worker/build-info.json > "$tmp/build-info.json"
node - "$tmp/build-info.json" "$expected_worker_version" <<'NODE'
const fs = require('node:fs')
const build = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (build.version !== process.argv[3]) throw new Error('worker package version does not match its release tag')
if (!/^[0-9a-f]{40}$/.test(build.sourceCommit ?? '')) throw new Error('worker source commit is not pinned')
if (!/^[0-9a-f]{64}$/.test(build.opencode?.binarySha256 ?? '')) throw new Error('OpenCode binary SHA-256 is missing')
if (typeof build.opencode?.version !== 'string' || !build.opencode.version) throw new Error('OpenCode version is missing')
NODE

opencode_version="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).opencode.version)' "$tmp/build-info.json")"
binary_sha256="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).opencode.binarySha256)' "$tmp/build-info.json")"
tar -xOf "$tmp/$archive_name" ./opencode > "$tmp/opencode"
chmod 0755 "$tmp/opencode"
echo "$binary_sha256  $tmp/opencode" | sha256sum --check --status
test "$("$tmp/opencode" --version)" = "$opencode_version"
sudo install -o root -g root -m 0755 "$tmp/opencode" /usr/local/bin/opencode
echo "$binary_sha256  /usr/local/bin/opencode" | sha256sum --check --status
test "$(/usr/local/bin/opencode --version)" = "$opencode_version"
echo "Provisioned OpenCode version=$opencode_version worker_release=$release_tag sha256=$binary_sha256"
