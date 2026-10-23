#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exec > >(tee "$project_root/record.log") 2>&1

check_contracts() {
    local compiler="$project_root/.local/bin/solc-0.8.30"
    local actions_domain actions_encoding actions_hash

    cd "$project_root/contracts"
    printf 'Building contracts offline...\n'
    forge build --use "$compiler" --offline

    printf 'Checking protocol encoding offline...\n'
    actions_domain="$(cast keccak 'OnChainTacticalArena.Actions')"
    actions_encoding="$(cast abi-encode \
        'f(bytes32,(uint8,uint8,uint8,uint8[4])[3])' \
        "$actions_domain" \
        '[(0,255,0,[0,0,0,0]),(0,255,0,[0,0,0,0]),(0,255,0,[0,0,0,0])]')"
    actions_hash="$(cast keccak "$actions_encoding")"

    forge script script/CheckProtocol.s.sol:CheckProtocol \
        --sig 'run(bytes32)' "$actions_hash" \
        --use "$compiler" --offline
    printf 'Protocol encoding checks passed.\n'
}

check_contracts

cd "$project_root/server"
printf 'Validating map...\n'
go run ./cmd/maptool -map "$project_root/config/map.json"
printf 'Starting backend...\n'
exec go run ./cmd/arena-server
