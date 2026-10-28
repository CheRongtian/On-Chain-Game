#!/usr/bin/env bash

# Sourced by the backend launcher; this file has no standalone startup flow.
local_rpc_url="http://127.0.0.1:8545"
local_player_a="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
local_player_b="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
local_anvil_pid=""
arena_address=""
deployment_block=""

start_local_chain() {
    local attempt

    if lsof -nP -iTCP:8545 -sTCP:LISTEN >/dev/null 2>&1; then
        printf 'Port 8545 is already in use. Stop its existing server before starting the backend.\n' >&2
        return 1
    fi

    printf 'Starting a fresh local chain...\n'
    anvil --host 127.0.0.1 --port 8545 --chain-id 31337 --hardfork cancun \
        --accounts 2 \
        --mnemonic 'test test test test test test test test test test test junk' &
    local_anvil_pid=$!

    for attempt in {1..50}; do
        if ! kill -0 "$local_anvil_pid" 2>/dev/null; then
            wait "$local_anvil_pid" || true
            printf 'The local chain exited during startup.\n' >&2
            return 1
        fi
        if lsof -nP -a -p "$local_anvil_pid" -iTCP:8545 -sTCP:LISTEN >/dev/null 2>&1; then
            # Disable routine RPC chatter while keeping command errors and service logs visible.
            cast rpc anvil_setLoggingEnabled false --rpc-url "$local_rpc_url" >/dev/null
            printf 'Local chain is listening at %s.\n' "$local_rpc_url"
            return 0
        fi
        sleep 0.1
    done

    printf 'The local chain did not start listening within five seconds.\n' >&2
    return 1
}

stop_local_chain() {
    if [[ -n "$local_anvil_pid" ]]; then
        kill "$local_anvil_pid" 2>/dev/null || true
        wait "$local_anvil_pid" 2>/dev/null || true
        local_anvil_pid=""
        node "$project_root/scripts/client-contract.mjs" clear
    fi
}

deploy_local_arena() {
    local compiler="$project_root/.local/bin/solc-0.8.30"
    local deployment deployment_status=0

    cd "$project_root/contracts"
    printf 'Deploying Arena to the local chain...\n'
    deployment="$(forge create src/Arena.sol:Arena --broadcast \
        --unlocked --from "$local_player_a" --rpc-url "$local_rpc_url" \
        --use "$compiler" --offline --json)" || deployment_status=$?
    printf '%s\n' "$deployment"
    if (( deployment_status != 0 )); then
        return "$deployment_status"
    fi
    arena_address="$(printf '%s\n' "$deployment" | \
        sed -nE 's/^[[:space:]]*"deployedTo":[[:space:]]*"(0x[[:xdigit:]]{40})".*/\1/p')"
    if [[ -z "$arena_address" ]]; then
        printf 'Could not read the Arena address from the deployment output.\n' >&2
        return 1
    fi

    deployment_block="$(cast block-number --rpc-url "$local_rpc_url")"
    printf 'RPC_URL=%s\nCHAIN_ID=31337\nARENA_ADDRESS=%s\nDEPLOYMENT_BLOCK=%s\n' \
        "$local_rpc_url" "$arena_address" "$deployment_block"
}

check_local_arena() {
    local compiler="$project_root/.local/bin/solc-0.8.30"

    printf 'Creating a room, joining with another account, and starting as its host...\n'
    cast send "$arena_address" 'createMatch(uint8)' 1 \
        --unlocked --from "$local_player_a" --rpc-url "$local_rpc_url"
    cast send "$arena_address" 'joinMatch(uint256)' 1 \
        --unlocked --from "$local_player_b" --rpc-url "$local_rpc_url"
    cast send "$arena_address" 'startMatch(uint256)' 1 \
        --unlocked --from "$local_player_a" --rpc-url "$local_rpc_url"

    printf 'Checking room state, permissions, deadlines, and initial state...\n'
    cd "$project_root/contracts"
    forge script script/CheckArena.s.sol:CheckArena \
        --sig 'run(address)' "$arena_address" --rpc-url "$local_rpc_url" \
        --use "$compiler" --offline
    printf 'Room lifecycle checks passed. Local match 1 is in Commit.\n'
}

check_local_turns() {
    local compiler="$project_root/.local/bin/solc-0.8.30"
    local orders actions_domain actions_encoding actions_hash rules_hash type_hash
    local salt_a salt_b encoded commitment_a commitment_b

    # Public HOLD orders and fixed salts are used only for this disposable demonstration.
    orders='[(0,255,0,[0,0,0,0]),(0,255,0,[0,0,0,0]),(0,255,0,[0,0,0,0])]'
    printf -v salt_a '0x%064x' 1
    printf -v salt_b '0x%064x' 2
    actions_domain="$(cast keccak 'OnChainTacticalArena.Actions')"
    actions_encoding="$(cast abi-encode \
        'f(bytes32,(uint8,uint8,uint8,uint8[4])[3])' "$actions_domain" "$orders")"
    actions_hash="$(cast keccak "$actions_encoding")"
    rules_hash="$(cast call "$arena_address" 'getRulesHash()(bytes32)' --rpc-url "$local_rpc_url")"
    type_hash="$(cast keccak \
        'ActionCommitment((uint256,address,uint256),uint8,address,bytes32,bytes32,bytes32)')"
    encoded="$(cast abi-encode \
        'f(bytes32,(uint256,address,uint256),uint8,address,bytes32,bytes32,bytes32)' \
        "$type_hash" "(31337,$arena_address,1)" 1 "$local_player_a" \
        "$rules_hash" "$actions_hash" "$salt_a")"
    commitment_a="$(cast keccak "$encoded")"
    encoded="$(cast abi-encode \
        'f(bytes32,(uint256,address,uint256),uint8,address,bytes32,bytes32,bytes32)' \
        "$type_hash" "(31337,$arena_address,1)" 1 "$local_player_b" \
        "$rules_hash" "$actions_hash" "$salt_b")"
    commitment_b="$(cast keccak "$encoded")"

    printf 'Committing orders with both local accounts...\n'
    cast send "$arena_address" 'commitActions(uint256,uint8,bytes32)' 1 1 "$commitment_a" \
        --unlocked --from "$local_player_a" --rpc-url "$local_rpc_url"
    cast send "$arena_address" 'commitActions(uint256,uint8,bytes32)' 1 1 "$commitment_b" \
        --unlocked --from "$local_player_b" --rpc-url "$local_rpc_url"

    printf 'Revealing the public demonstration orders with both local accounts...\n'
    cast send "$arena_address" \
        'revealActions(uint256,uint8,(uint8,uint8,uint8,uint8[4])[3],bytes32)' \
        1 1 "$orders" "$salt_a" \
        --unlocked --from "$local_player_a" --rpc-url "$local_rpc_url"
    cast send "$arena_address" \
        'revealActions(uint256,uint8,(uint8,uint8,uint8,uint8[4])[3],bytes32)' \
        1 1 "$orders" "$salt_b" \
        --unlocked --from "$local_player_b" --rpc-url "$local_rpc_url"

    printf 'Checking turn permissions, privacy, rollback, deadlines, and timeouts...\n'
    cd "$project_root/contracts"
    forge script script/CheckTurns.s.sol:CheckTurns \
        --sig 'run(address)' "$arena_address" --rpc-url "$local_rpc_url" \
        --use "$compiler" --offline
    printf 'Turn protocol checks passed. Local match 1 is Resolvable.\n'
}

check_local_matches() {
    local compiler="$project_root/.local/bin/solc-0.8.30"

    printf 'Running complete matches and recording transaction gas...\n'
    cd "$project_root/server"
    go run ./cmd/demotool --rpc "$local_rpc_url" --arena "$arena_address" \
        --output "$project_root/.local/demo"

    printf 'Checking complete match results, settlement events, replay, and state invariants...\n'
    cd "$project_root/contracts"
    forge script script/CheckMatches.s.sol:CheckMatches \
        --sig 'run(address)' "$arena_address" --rpc-url "$local_rpc_url" \
        --use "$compiler" --offline
    printf 'Complete match checks passed. Local matches 1-4 are Finished.\n'
}
