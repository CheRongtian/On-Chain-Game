#!/usr/bin/env bash

# Sourced by the backend launcher; this file has no standalone startup flow.
local_rpc_url="http://127.0.0.1:8545"
local_player_a="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
local_player_b="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
local_anvil_pid=""
arena_address=""

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
    fi
}

deploy_local_arena() {
    local compiler="$project_root/.local/bin/solc-0.8.30"
    local deployment deployment_block deployment_status=0

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

    printf 'Creating and joining a match with two local accounts...\n'
    cast send "$arena_address" 'createMatch(uint8)' 1 \
        --unlocked --from "$local_player_a" --rpc-url "$local_rpc_url"
    cast send "$arena_address" 'joinMatch(uint256)' 1 \
        --unlocked --from "$local_player_b" --rpc-url "$local_rpc_url"

    printf 'Checking room state, permissions, deadlines, and initial state...\n'
    cd "$project_root/contracts"
    forge script script/CheckArena.s.sol:CheckArena \
        --sig 'run(address)' "$arena_address" --rpc-url "$local_rpc_url" \
        --use "$compiler" --offline
    printf 'Room lifecycle checks passed. Local match 1 is in Commit.\n'
}
