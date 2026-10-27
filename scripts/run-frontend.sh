#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$project_root/client"
node "$project_root/scripts/client-contract.mjs" ready
printf 'Preparing frontend dependencies...\n'
npm install --no-audit --no-fund

if [[ -f "$project_root/contracts/out/Arena.sol/Arena.json" ]]; then
    node "$project_root/scripts/client-contract.mjs" abi
fi

exec npm run dev
