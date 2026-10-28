#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: > "$project_root/record.log"
exec > >(tee -a "$project_root/record.log") 2>&1

mode="${1:-start}"
if (( $# > 0 )); then
    shift
fi
case "$mode" in
    start|demo|test|verify|simulate|restart|rescan|reindex|status) ;;
    *) printf 'Unknown backend mode: %s. Use start, demo, test, verify, simulate, restart, rescan, reindex, or status.\n' "$mode" >&2; exit 1 ;;
esac
if [[ "$mode" != "verify" && "$mode" != "simulate" ]] && (( $# > 0 )); then
    printf 'The %s mode takes no additional arguments.\n' "$mode" >&2
    exit 1
fi

if [[ -f "$project_root/.env" ]]; then
    set -a
    source "$project_root/.env"
    set +a
fi
source "$project_root/scripts/local-indexer.sh"

run_backend_tests() {
    run_indexer_checks
    run_frontend_checks
}

case "$mode" in
    restart|rescan|reindex) request_indexer_operation "$mode"; exit ;;
    status)
        if [[ ! -x "$indexer_binary" ]]; then
            printf 'Start the backend before requesting its status.\n' >&2
            exit 1
        fi
        cd "$project_root/server"
        "$indexer_binary" status
        exit
        ;;
esac

cd "$project_root/server"
if [[ "$mode" == "verify" || "$mode" == "simulate" ]]; then
    go run -mod=mod ./cmd/arena-server "$mode" "$@"
    exit
fi

build_go_backend

if [[ "$mode" == "test" || "$mode" == "demo" ]]; then
    source "$project_root/scripts/check-indexer.sh"
    source "$project_root/scripts/check-frontend.sh"
    trap 'exit 130' INT
    trap 'exit 143' TERM
    if backend_running_for_checks; then
        trap stop_backend_tests EXIT
        if [[ "$mode" == "demo" ]]; then
            node "$project_root/scripts/client-contract.mjs" ready
        fi
        printf 'Using the running backend to prepare replay history.\n'
        wait_for_backend_ready "$existing_backend_pid"
        if [[ "$mode" == "demo" ]]; then
            run_indexer_checks
            printf 'Demo is ready. Keep the existing backend running, then start ./scripts/run-frontend.sh and open History.\n'
        else
            run_backend_tests
        fi
        exit
    fi
fi

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
trap stop_backend EXIT
printf '%s\n' "$$" > "$backend_pid_file"
deploy_local_arena

node "$project_root/scripts/client-contract.mjs" publish \
    "$local_rpc_url" "$arena_address" "$deployment_block"

cd "$project_root/server"
start_go_indexer
trap restart_go_indexer USR1
if [[ "$mode" == "test" ]]; then
    printf 'Waiting for backend readiness before running checks...\n'
    wait_for_backend_ready "$indexer_pid"
    run_backend_tests
    printf 'Backend checks completed. Stopping services started by this command.\n'
    exit
fi
if [[ "$mode" == "demo" ]]; then
    printf 'Preparing two complete matches for browser replay...\n'
    wait_for_backend_ready "$indexer_pid"
    run_indexer_checks
    printf 'Demo is ready. Start ./scripts/run-frontend.sh in another terminal and open History. This backend stays running until Ctrl+C.\n'
fi

if [[ "$mode" != "demo" ]]; then
    printf 'Waiting for the Go services to become ready. Press Ctrl+C to stop the backend.\n'
fi
while true; do
    active_indexer_pid="$indexer_pid"
    indexer_status=0
    wait "$active_indexer_pid" || indexer_status=$?
    if [[ "$active_indexer_pid" != "$indexer_pid" ]]; then
        continue
    fi
    printf 'Go services exited with status %d. Stopping the backend.\n' "$indexer_status" >&2
    if (( indexer_status == 0 )); then
        exit 1
    fi
    exit "$indexer_status"
done
