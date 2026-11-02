#!/usr/bin/env bash
# Internal Geth lifecycle; the isolated fault checks keep their existing Anvil chain.
local_geth_pid=""

start_archive_chain() {
    local attempt saved_pid
    node "$project_root/scripts/client-contract.mjs" start-legacy
    if [[ -f "$project_root/.local/geth.pid" ]]; then
        read -r saved_pid < "$project_root/.local/geth.pid"
        if [[ "$saved_pid" =~ ^[0-9]+$ ]] && lsof -nP -a -p "$saved_pid" -iTCP:"$local_rpc_port" -sTCP:LISTEN >/dev/null 2>&1; then
            local_geth_pid="$saved_pid"
            node "$project_root/scripts/client-contract.mjs" checkpoint "$local_rpc_url"
            printf 'Reusing this project’s Geth archive node.\n'
            return
        fi
    fi
    if lsof -nP -iTCP:"$local_rpc_port" -sTCP:LISTEN >/dev/null 2>&1; then
        printf 'Port %s is already in use. Configure an available ARENA_RPC_PORT; the other service was left running.\n' "$local_rpc_port" >&2
        return 1
    fi
    if [[ -f "$project_root/.local/archive/deployment.json" && ! -f "$project_root/.local/archive/confirmed.json" ]]; then
        printf 'The archive deployment has no durable checkpoint. Restore the matching Geth data; no replacement chain was created.\n' >&2
        return 1
    fi
    node "$project_root/scripts/client-contract.mjs" start-geth "$local_rpc_port"
    read -r local_geth_pid < "$project_root/.local/geth.pid"
    for attempt in {1..300}; do
        if ! kill -0 "$local_geth_pid" 2>/dev/null; then
            printf 'Geth could not start or recover. Existing data was retained.\n' >&2
            return 1
        fi
        if lsof -nP -a -p "$local_geth_pid" -iTCP:"$local_rpc_port" -sTCP:LISTEN >/dev/null 2>&1; then
            node "$project_root/scripts/client-contract.mjs" checkpoint "$local_rpc_url"
            printf 'Local Geth archive RPC: %s.\n' "$local_rpc_url"
            return
        fi
        sleep 0.1
    done
    printf 'Geth did not start listening within thirty seconds.\n' >&2
    return 1
}

deploy_archive_arena() {
    local compiler="$project_root/.local/bin/solc-0.8.30"
    local result="$project_root/.local/archive/deploy-result.json"
    if [[ -f "$project_root/.local/archive/deployment.json" ]]; then
        node "$project_root/scripts/client-contract.mjs" publish "$local_rpc_url"
    elif [[ -s "$result" ]]; then
        printf 'Completing the saved Arena deployment record without deploying again...\n'
        node "$project_root/scripts/client-contract.mjs" publish "$local_rpc_url" "$result"
    elif [[ -s "$result" ]]; then
        printf 'Completing the saved Arena deployment record without deploying again...\n'
        node "$project_root/scripts/client-contract.mjs" publish "$local_rpc_url" "$result"
    else
        cd "$project_root/contracts"
        printf 'Deploying Arena once to the Geth archive chain...\n'
        forge create src/Arena.sol:Arena --broadcast --unlocked --from "$local_player_a" \
            --rpc-url "$local_rpc_url" --use "$compiler" --offline --json > "$result"
        cat "$result"
        node "$project_root/scripts/client-contract.mjs" publish "$local_rpc_url" "$result"
    fi
    arena_address="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).arenaAddress' "$project_root/client/public/deployment.json")"
    deployment_block="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).deploymentBlock' "$project_root/client/public/deployment.json")"
    local_chain_verified=true
}

stop_archive_chain() {
    local deadline
    if [[ -n "$local_geth_pid" ]] && kill -0 "$local_geth_pid" 2>/dev/null; then
        if ! node "$project_root/scripts/client-contract.mjs" checkpoint "$local_rpc_url"; then
            printf 'Final Geth checkpoint failed. The node and its process record were retained; restore persistence before stopping it.\n' >&2
            return 1
        fi
        kill -TERM "$local_geth_pid"
        deadline=$((SECONDS + 30))
        while kill -0 "$local_geth_pid" 2>/dev/null; do
            if (( SECONDS >= deadline )); then
                printf 'Geth did not finish stopping. Its process record and archive were retained.\n' >&2
                return 1
            fi
            sleep 0.1
        done
        local_geth_pid=""
        rm -f "$project_root/.local/geth.pid"
        printf 'Geth stopped. Confirmed blocks, account states, receipts, and deployment archives are retained.\n'
    fi
    node "$project_root/scripts/client-contract.mjs" stop-legacy || return 1
    node "$project_root/scripts/client-contract.mjs" clear
}
