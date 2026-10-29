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
    start|demo|test|reset|verify|simulate|restart|rescan|reindex|status) ;;
    *) printf 'Unknown backend mode: %s. Use start, demo, test, reset, verify, simulate, restart, rescan, reindex, or status.\n' "$mode" >&2; exit 1 ;;
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
    source "$project_root/scripts/check-safety.sh"
    run_safety_checks
    run_indexer_checks keeper
    run_frontend_checks
    printf 'PASS: all backend, browser gameplay, and recovery checks completed.\n'
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

require_compose
configure_local_database

if [[ "$mode" == "reset" ]]; then
    reset_local_demo
    exit
fi

for dependency in go node forge cast anvil curl lsof; do
    if ! command -v "$dependency" >/dev/null 2>&1; then
        printf 'Missing required tool: %s. Prepare it before starting this backend.\n' "$dependency" >&2
        exit 1
    fi
done
if [[ ! -x "$project_root/.local/bin/solc-0.8.30" ]]; then
    printf 'The local Solidity compiler is missing. Restore the existing compiler before starting.\n' >&2
    exit 1
fi
build_go_backend

if [[ "$mode" == "test" ]]; then
    source "$project_root/scripts/check-frontend.sh"
    prepare_frontend_checks
fi

source "$project_root/scripts/check-indexer.sh"
if backend_running_for_checks; then
    if [[ -z "$(arena_compose ps -q --status running api)" ]]; then
        printf 'The existing launcher uses the old runtime. Stop it, then start this Compose backend again.\n' >&2
        exit 1
    fi
    node "$project_root/scripts/client-contract.mjs" ready
    wait_for_backend_ready "$existing_backend_pid"
    if [[ "$mode" == "start" ]]; then
        printf 'This backend is already running. Keep its terminal open and start the frontend normally.\n'
        exit
    fi
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap stop_backend_tests EXIT
    if [[ "$mode" == "demo" ]]; then
        run_indexer_checks
        printf 'Demo is ready. Keep the existing backend running, then start ./scripts/run-frontend.sh and open History.\n'
    else
        run_backend_tests
    fi
    exit
fi

require_local_images
build_linux_backend
printf 'Building the Go service image from local ubuntu:24.04...\n'
arena_compose build api

source "$project_root/scripts/local-chain.sh"
mkdir -p "$project_root/.local" "$project_root/client/public"
trap stop_backend EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "$$" > "$backend_pid_file"
node "$project_root/scripts/client-contract.mjs" clear

cd "$project_root/contracts"
printf 'Building Arena with the local compiler...\n'
forge build --use "$project_root/.local/bin/solc-0.8.30" --offline
node "$project_root/scripts/client-contract.mjs" abi

printf 'Preparing the project PostgreSQL container...\n'
if ! arena_compose up -d --wait db; then
    arena_compose logs db
    exit 1
fi
start_local_chain
deploy_local_arena

node "$project_root/scripts/client-contract.mjs" publish \
    "$local_rpc_url" "$arena_address" "$deployment_block"

cd "$project_root/server"
start_go_indexer
trap restart_go_indexer USR1
wait_for_backend_ready "$indexer_pid"
printf 'Local Arena is ready. Read API: http://%s. Start ./scripts/run-frontend.sh in another terminal.\n' "${HTTP_ADDRESS:-127.0.0.1:18081}"
if [[ "$mode" == "test" ]]; then
    run_backend_tests
    printf 'Backend checks completed. Stopping services started by this command.\n'
    exit
fi
if [[ "$mode" == "demo" ]]; then
    printf 'Preparing two complete matches for browser replay...\n'
    run_indexer_checks
    printf 'Demo is ready. Start ./scripts/run-frontend.sh in another terminal and open History. This backend stays running until Ctrl+C.\n'
fi

printf 'Press Ctrl+C to stop this backend. The project database volume is retained.\n'
while kill -0 "$indexer_pid" 2>/dev/null; do
    wait "$indexer_pid" || true
done
printf 'The API container stopped. Inspect the preceding service logs.\n' >&2
exit 1
