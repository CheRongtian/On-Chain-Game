#!/usr/bin/env bash

# Sourced by the backend launcher; operations keep its existing Anvil chain alive.
indexer_pid=""
backend_test_pid=""
backend_pid_file="$project_root/.local/backend.pid"
indexer_command_file="$project_root/.local/indexer-command"
indexer_binary="$project_root/.local/bin/arena-server"

build_go_backend() {
    cd "$project_root/server"
    mkdir -p "$project_root/.local/bin"
    printf 'Building Go backend...\n'
    go build -mod=mod -o "$indexer_binary" ./cmd/arena-server
}

wait_for_backend_ready() {
    local monitored_pid="$1" ready_deadline=$((SECONDS + 60))
    while (( SECONDS < ready_deadline )); do
        if ! kill -0 "$monitored_pid" 2>/dev/null; then
            printf 'The backend process exited before its read API became ready.\n' >&2
            return 1
        fi
        if curl --fail --silent --max-time 1 --output /dev/null \
            "http://${HTTP_ADDRESS:-127.0.0.1:8080}/ready"; then
            printf 'Backend services are ready for checks.\n'
            return 0
        fi
        sleep 0.1
    done
    printf 'The read API did not become ready within 60 seconds. See the backend output above.\n' >&2
    return 1
}

run_backend_check() {
    local check_status
    # Waiting on a background check lets this launcher handle its Go restart requests.
    "$@" &
    backend_test_pid=$!
    while true; do
        check_status=0
        wait "$backend_test_pid" || check_status=$?
        if (( check_status > 128 )) && kill -0 "$backend_test_pid" 2>/dev/null; then
            continue
        fi
        backend_test_pid=""
        return "$check_status"
    done
}

stop_backend_tests() {
    if [[ -n "$backend_test_pid" ]]; then
        kill -TERM "$backend_test_pid" 2>/dev/null || true
        wait "$backend_test_pid" 2>/dev/null || true
        backend_test_pid=""
    fi
}

request_indexer_operation() {
    local operation="$1" launcher_pid
    if [[ ! -f "$backend_pid_file" ]]; then
        printf 'No backend launcher is running. Start ./scripts/run-backend.sh first.\n' >&2
        return 1
    fi
    read -r launcher_pid < "$backend_pid_file"
    if [[ ! "$launcher_pid" =~ ^[0-9]+$ ]] || ! kill -0 "$launcher_pid" 2>/dev/null; then
        printf 'The recorded backend launcher is no longer running. Start it again.\n' >&2
        return 1
    fi
    printf '%s\n' "$operation" > "$indexer_command_file"
    kill -USR1 "$launcher_pid"
    printf '%s requested. The backend will print the result and a new ready message.\n' "$operation"
}

start_go_indexer() {
    local operation="${1:-}"
    printf 'Starting Go Indexer and read API...\n'
    if [[ -n "$operation" ]]; then
        "$indexer_binary" serve "$operation" &
    else
        "$indexer_binary" serve &
    fi
    indexer_pid=$!
}

stop_go_indexer() {
    if [[ -n "$indexer_pid" ]]; then
        kill -TERM "$indexer_pid" 2>/dev/null || true
        wait "$indexer_pid" 2>/dev/null || true
        indexer_pid=""
    fi
}

restart_go_indexer() {
    local operation
    if [[ ! -f "$indexer_command_file" ]]; then
        return
    fi
    read -r operation < "$indexer_command_file"
    rm -f "$indexer_command_file"
    case "$operation" in
        restart|rescan|reindex) ;;
        *) printf 'Unknown indexing operation: %s\n' "$operation" >&2; return 1 ;;
    esac
    printf 'Restarting Go services; the local chain and browser rooms remain running.\n'
    stop_go_indexer
    if [[ "$operation" == "restart" ]]; then
        start_go_indexer
    else
        start_go_indexer "$operation"
    fi
}

stop_backend() {
    trap '' USR1
    stop_backend_tests
    stop_go_indexer
    stop_local_chain
    rm -f "$backend_pid_file" "$indexer_command_file"
}
