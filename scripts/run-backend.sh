#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec > >(tee "$project_root/record.log") 2>&1

source "$project_root/scripts/local-chain.sh"
trap stop_local_chain EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node "$project_root/scripts/client-contract.mjs" clear

cd "$project_root/contracts"
printf 'Building Arena with the local compiler...\n'
forge build --use "$project_root/.local/bin/solc-0.8.30" --offline
node "$project_root/scripts/client-contract.mjs" abi

start_local_chain
deploy_local_arena

node "$project_root/scripts/client-contract.mjs" publish \
    "$local_rpc_url" "$arena_address" "$deployment_block"

cd "$project_root/server"
go run ./cmd/arena-server
printf 'Local Arena is ready. Create a room in the browser.\n'
printf 'The host must click Start game to begin. Press Ctrl+C to stop the local chain.\n'
wait "$local_anvil_pid"
