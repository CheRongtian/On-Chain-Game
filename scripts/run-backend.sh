#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: > "$project_root/record.log"
if [[ "${ARENA_TEST_PROJECT_ROOT:-}" != "$project_root" ]]; then
    exec > >(tee -ai "$project_root/record.log") 2>&1
fi

mode="${1:-start}"
if (( $# > 0 )); then
    shift
fi
case "$mode" in
    start|demo|test|reset|verify|simulate|restart|rescan|reindex|status|backup|restore|release) ;;
    *) printf 'Unknown backend mode: %s. Use start, demo, test, reset, verify, simulate, restart, rescan, reindex, status, backup, restore, or release.\n' "$mode" >&2; exit 1 ;;
esac
if [[ "$mode" == "restore" && $# != 1 ]]; then
    printf 'Use ./scripts/run-backend.sh restore /absolute/path/to/backup-directory\n' >&2
    exit 1
fi
if [[ "$mode" != "verify" && "$mode" != "simulate" && "$mode" != "restore" ]] && (( $# > 0 )); then
    printf 'The %s mode takes no additional arguments.\n' "$mode" >&2
    exit 1
fi

if [[ ( "$mode" == "test" || "$mode" == "reset" ) && "${ARENA_TEST_PROJECT_ROOT:-}" != "$project_root" ]]; then
    node "$project_root/scripts/baseline.mjs" preserve
fi
if [[ "$mode" == "test" && "${ARENA_TEST_PROJECT_ROOT:-}" != "$project_root" ]]; then
    node "$project_root/scripts/release.mjs" begin
    node "$project_root/scripts/test-workspace.mjs"
    export ARENA_TEST_PROJECT_ROOT="$project_root/.local/test"
    exec "$ARENA_TEST_PROJECT_ROOT/scripts/run-backend.sh" test
fi

if [[ -f "$project_root/.env" ]]; then
    set -a
    source "$project_root/.env"
    set +a
fi
source "$project_root/scripts/local-indexer.sh"

run_operational_checks() {
    printf 'Checking operational controls and real PostgreSQL backup/recovery...\n'
    run_backend_check node "$project_root/client/scripts/check-operations.mjs" prepare
    stop_go_indexer
    run_backend_check node "$project_root/client/scripts/check-operations.mjs" restore
    start_go_indexer
    wait_for_backend_ready "$indexer_pid"
    run_backend_check node "$project_root/client/scripts/check-operations.mjs" recovered
    request_indexer_operation reindex
    run_backend_check node "$project_root/client/scripts/check-operations.mjs" reindexed
}

run_backend_tests() {
    local browser
    printf 'Checking frozen squad rules, maps, protocol, shared compatibility baseline, actual Solidity data and static action validation before integration acceptance...\n'
    run_backend_check node "$project_root/scripts/check-squad-rules.mjs"
    run_backend_check node "$project_root/scripts/check-maps.mjs"
    run_backend_check node "$project_root/client/scripts/check-squad-protocol.mjs"
    printf 'Checking archived Solidity sources with the local compiler...\n'
    run_backend_check node "$project_root/scripts/client-contract.mjs" check-sources
    source "$project_root/scripts/check-safety.sh"
    run_safety_checks
    run_indexer_checks keeper
    run_operational_checks
    run_frontend_checks
    printf 'PASS: Anvil rules, controlled reorgs, browser gameplay, and fault regression.\n'
    printf 'Switching the isolated environment to the production Geth archive workflow...\n'
    stop_go_indexer
    stop_local_chain
    cp "$project_root/.local/indexer/acceptance.json" "$project_root/.local/indexer/anvil-acceptance.json"
    local_chain_engine=geth
    start_local_chain
    deploy_local_arena
    start_go_indexer
    wait_for_backend_ready "$indexer_pid"
    run_indexer_checks demo
    run_operational_checks
    printf 'Repeating the complete browser gameplay acceptance on Geth...\n'
    run_backend_check node "$project_root/client/scripts/check-gameplay.mjs"
    for browser in firefox webkit; do
        printf 'Checking the same two-player gameplay, secret recovery and replay on %s...\n' "$browser"
        run_backend_check node "$project_root/client/scripts/check-gameplay.mjs" "$browser"
    done
    for browser in chromium firefox webkit; do
        printf 'Checking database, Go and SSE recovery on Geth with %s...\n' "$browser"
        run_backend_check node "$project_root/client/scripts/check-updates.mjs" "$browser"
    done
    printf 'Checking Geth crash recovery, archives, frozen sources, and historical accounts...\n'
    run_backend_check node "$project_root/client/scripts/check-persistence.mjs"
    run_backend_check node "$project_root/scripts/client-contract.mjs" acceptance-summary
    mkdir -p "$project_root/.local/regression"
    arena_compose exec -T db pg_dump --schema-only --no-owner --no-privileges -U arena onchain_arena \
        > "$project_root/.local/regression/database-schema.sql"
    run_backend_check node "$project_root/scripts/baseline.mjs" check
    printf 'All acceptance reports matched. Completing service cleanup before reporting overall success...\n'
}

case "$mode" in
    release) node "$project_root/scripts/release.mjs"; exit ;;
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
    if [[ "$mode" == "verify" ]]; then
        node "$project_root/scripts/check-squad-rules.mjs"
        node "$project_root/scripts/check-maps.mjs"
        node "$project_root/client/scripts/check-squad-protocol.mjs"
    fi
    go run -mod=mod ./cmd/arena-server "$mode" "$@"
    if [[ "$mode" == "verify" ]]; then
        printf 'PASS: offline verification completed: squad rules, map geometry, protocol encoding, shared compatibility baseline, actual Solidity data, static action validation and existing Go/Solidity vectors.\n'
    fi
    exit
fi

require_compose
configure_local_database
if [[ "$mode" == "backup" || "$mode" == "restore" ]]; then
    if [[ "$mode" == "restore" ]]; then
        printf 'Restore will replace this project database schema and records from the selected backup. Stop the backend first. A recovery backup is saved before replacement; chain data and browser secrets remain separate.\n'
        read -r -p 'Type restore to continue: ' restore_answer
        if [[ "$restore_answer" != "restore" ]]; then printf 'Restore cancelled.\n'; exit; fi
    fi
    node "$project_root/scripts/database-backup.mjs" "$mode" "$@"
    exit
fi
if [[ "$mode" == "test" ]]; then
    arena_compose down --volumes
fi

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
    if [[ ! -f "$project_root/.local/archive/deployment.json" ]]; then
        node "$project_root/scripts/client-contract.mjs" preserve
        printf 'Keep game tabs idle. Stop the old backend terminal, then run this same entry again to restore the saved chain with the current runtime.\n'
        exit
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
        run_indexer_checks demo
        printf 'Demo is ready. Keep the existing backend running, then start ./scripts/run-frontend.sh and open History.\n'
    else
        run_backend_tests
    fi
    exit
fi

build_go_backend
configure_image_platform
build_linux_backend
node "$project_root/scripts/build-cache.mjs" images

source "$project_root/scripts/local-chain.sh"
source "$project_root/scripts/archive-chain.sh"
mkdir -p "$project_root/.local" "$project_root/client/public"
trap stop_backend EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
printf '%s\n' "$$" > "$backend_pid_file"
node "$project_root/scripts/client-contract.mjs" clear

cd "$project_root/contracts"
printf 'Checking Arena build inputs with the local compiler; valid Foundry artifacts are reused...\n'
forge build --use "$project_root/.local/bin/solc-0.8.30" --offline
node "$project_root/scripts/client-contract.mjs" abi

printf 'Preparing the project PostgreSQL container...\n'
if ! arena_compose up -d --wait db; then
    arena_compose logs db
    exit 1
fi
start_local_chain
deploy_local_arena

cd "$project_root/server"
start_go_indexer
trap restart_go_indexer USR1
wait_for_backend_ready "$indexer_pid"
if [[ "$mode" == "test" ]]; then
    printf 'The isolated backend is ready. Running acceptance in this terminal...\n'
else
    printf 'Local Arena is ready. Read API: http://%s. Start ./scripts/run-frontend.sh in another terminal.\n' "${HTTP_ADDRESS:-127.0.0.1:18081}"
fi
if [[ "$mode" == "test" ]]; then
    run_backend_tests
    printf 'Backend checks completed. Stopping services started by this command.\n'
    exit
fi
if [[ "$mode" == "demo" ]]; then
    printf 'Preparing two complete matches for browser replay...\n'
    run_indexer_checks demo
    printf 'Demo is ready. Start ./scripts/run-frontend.sh in another terminal and open History. This backend stays running until Ctrl+C.\n'
fi

printf 'Press Ctrl+C to save and stop this backend. The chain and project database are retained.\n'
while kill -0 "$indexer_pid" 2>/dev/null; do
    wait "$indexer_pid" || true
done
printf 'The API container stopped. Inspect the preceding service logs.\n' >&2
exit 1
