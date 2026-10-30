#!/usr/bin/env bash

# Sourced by the backend launcher; this file has no standalone startup flow.
local_rpc_port="${ARENA_RPC_PORT:-18545}"
local_rpc_url="http://127.0.0.1:$local_rpc_port"
local_checkpoint_pid=""
local_player_a="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
local_player_b="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
local_anvil_pid=""
local_chain_verified=false
local_anvil_adopted=false
arena_address=""
deployment_block=""

start_local_chain() {
    local attempt saved_pid
    local state="$project_root/.local/chain/state.json"
    local manifest="$project_root/.local/chain/deployment.json"
    local chain_args=(--host 127.0.0.1 --port "$local_rpc_port" --chain-id 31337 --hardfork cancun --gas-limit 30000000 --accounts 2)
    mkdir -p "$project_root/.local/chain"
    if [[ -f "$project_root/.local/anvil.pid" ]]; then
        read -r saved_pid < "$project_root/.local/anvil.pid"
        if [[ "$saved_pid" =~ ^[0-9]+$ ]] && lsof -nP -a -p "$saved_pid" -iTCP:"$local_rpc_port" -sTCP:LISTEN >/dev/null 2>&1; then
            local_anvil_pid="$saved_pid"
            local_anvil_adopted=true
            printf 'Reusing this project’s still-running Anvil process.\n'
            return
        fi
    fi
    if lsof -nP -iTCP:"$local_rpc_port" -sTCP:LISTEN >/dev/null 2>&1; then
        printf 'Port %s is already in use. Keep the other project running and configure an available ARENA_RPC_PORT.\n' "$local_rpc_port" >&2
        return 1
    fi
    if [[ -f "$manifest" && ! -s "$state" ]]; then
        printf 'The saved deployment has no chain checkpoint. Restore the checkpoint or explicitly reset; no new chain was created.\n' >&2
        return 1
    fi
    if [[ -s "$state" ]]; then
        if [[ ! -f "$manifest" ]]; then
            printf 'The chain checkpoint has no deployment record. Restore its matching record or explicitly reset.\n' >&2
            return 1
        fi
        chain_args+=(--load-state "$state")
        printf 'Restoring the saved local chain, transactions, receipts, and retained historical states...\n'
    else
        printf 'Starting the first local chain...\n'
    fi
    node "$project_root/scripts/client-contract.mjs" start-chain "${chain_args[@]}" \
        --mnemonic 'test test test test test test test test test test test junk'
    read -r local_anvil_pid < "$project_root/.local/anvil.pid"
    for attempt in {1..100}; do
        if ! kill -0 "$local_anvil_pid" 2>/dev/null; then
            wait "$local_anvil_pid" || true
            local_anvil_pid=""
            printf 'Anvil could not restore or start. Existing saved data was retained.\n' >&2
            return 1
        fi
        if lsof -nP -a -p "$local_anvil_pid" -iTCP:"$local_rpc_port" -sTCP:LISTEN >/dev/null 2>&1; then
            cast rpc anvil_setLoggingEnabled false --rpc-url "$local_rpc_url" >/dev/null
            printf 'Local chain is listening at %s.\n' "$local_rpc_url"
            return 0
        fi
        sleep 0.1
    done
    printf 'The local chain did not start listening within ten seconds.\n' >&2
    return 1
}

start_chain_checkpoints() {
    # Fault injection deliberately suspends Anvil in the isolated acceptance environment.
    [[ "$mode" != "test" ]] || return 0
    node "$project_root/scripts/client-contract.mjs" watch "$local_rpc_url" &
    local_checkpoint_pid=$!
}

stop_local_chain() {
    local stop_deadline
    if [[ -n "$local_checkpoint_pid" ]]; then
        kill -TERM "$local_checkpoint_pid" 2>/dev/null || true
        wait "$local_checkpoint_pid" 2>/dev/null || true
        local_checkpoint_pid=""
    fi
    if [[ -n "$local_anvil_pid" ]] && kill -0 "$local_anvil_pid" 2>/dev/null; then
        if [[ "$local_anvil_adopted" == true && "$local_chain_verified" != true ]]; then
            printf 'Deployment validation did not finish. The existing Anvil process and its unsaved games were left running.\n' >&2
            return 1
        fi
        kill -CONT "$local_anvil_pid" 2>/dev/null || true
        if [[ "$local_chain_verified" == true ]]; then
            if ! node "$project_root/scripts/client-contract.mjs" checkpoint "$local_rpc_url"; then
                printf 'Final checkpoint failed. Anvil was left running to preserve the unsaved games; resolve the save error before stopping it.\n' >&2
                return 1
            fi
            printf 'Local chain and transaction history saved.\n'
        fi
        kill -TERM "$local_anvil_pid" 2>/dev/null || true
        wait "$local_anvil_pid" 2>/dev/null || true
        stop_deadline=$((SECONDS + 30))
        while kill -0 "$local_anvil_pid" 2>/dev/null; do
            if (( SECONDS >= stop_deadline )); then
                printf 'Anvil did not finish stopping; its saved state and process record were retained.\n' >&2
                return 1
            fi
            sleep 0.1
        done
        local_anvil_pid=""
        local_chain_verified=false
        local_anvil_adopted=false
        rm -f "$project_root/.local/anvil.pid"
    fi
    node "$project_root/scripts/client-contract.mjs" clear
}

deploy_local_arena() {
    local compiler="$project_root/.local/bin/solc-0.8.30"
    local result="$project_root/.local/chain/deploy-result.json"
    if [[ -f "$project_root/.local/chain/deployment.json" ]]; then
        node "$project_root/scripts/client-contract.mjs" publish "$local_rpc_url"
    else
        cd "$project_root/contracts"
        printf 'Deploying Arena once to the local chain...\n'
        forge create src/Arena.sol:Arena --broadcast \
            --unlocked --from "$local_player_a" --rpc-url "$local_rpc_url" \
            --use "$compiler" --offline --json > "$result"
        cat "$result"
        node "$project_root/scripts/client-contract.mjs" publish "$local_rpc_url" "$result"
    fi
    arena_address="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).arenaAddress' "$project_root/client/public/deployment.json")"
    deployment_block="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).deploymentBlock' "$project_root/client/public/deployment.json")"
    node "$project_root/scripts/client-contract.mjs" checkpoint "$local_rpc_url"
    local_chain_verified=true
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
