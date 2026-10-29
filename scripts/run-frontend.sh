#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$project_root/client"
for dependency in node npm; do
    if ! command -v "$dependency" >/dev/null 2>&1; then
        printf 'Missing required tool: %s. Prepare it before starting the frontend.\n' "$dependency" >&2
        exit 1
    fi
done
node "$project_root/scripts/client-contract.mjs" ready
if [[ ! -x "$project_root/client/node_modules/.bin/vite" ]]; then
    printf 'Client dependencies are missing. In client/, run npm ci --no-audit --no-fund once, then start this script again.\n' >&2
    exit 1
fi
printf 'Using the existing frontend dependencies...\n'

if [[ -f "$project_root/contracts/out/Arena.sol/Arena.json" ]]; then
    node "$project_root/scripts/client-contract.mjs" abi
fi

exec npm run dev
