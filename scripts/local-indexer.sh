#!/usr/bin/env bash

# Host-side control; Go process recovery runs inside the API container.
source "$project_root/scripts/local-compose.sh"
indexer_pid=""
indexer_log_pid=""
compose_log_since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
backend_test_pid=""
backend_pid_file="$project_root/.local/backend.pid"
indexer_command_file="$project_root/.local/indexer-command"
indexer_binary="$project_root/.local/bin/arena-server"

build_go_backend() {
    cd "$project_root/server"
    mkdir -p "$project_root/.local/bin"
    printf 'Building Go backend...\n'
    GOTOOLCHAIN=local GOPROXY=off go build -mod=readonly -o "$indexer_binary" ./cmd/arena-server
}

build_linux_backend() {
    cd "$project_root/server"
    printf 'Building the Linux backend for %s with the installed Go and module cache...\n' "$ARENA_API_PLATFORM"
    GOTOOLCHAIN=local GOPROXY=off CGO_ENABLED=0 GOOS=linux GOARCH="${ARENA_API_PLATFORM#linux/}" \
        go build -mod=readonly -o "$project_root/.local/bin/arena-server-linux" ./cmd/arena-server
}

wait_for_backend_ready() {
    local monitored_pid="$1" ready_deadline=$((SECONDS + 60))
    while (( SECONDS < ready_deadline )); do
        if ! kill -0 "$monitored_pid" 2>/dev/null; then
            printf 'The backend process exited before its read API became ready.\n' >&2
            return 1
        fi
        if [[ -f "$project_root/.local/indexer-failure" ]]; then
            cat "$project_root/.local/indexer-failure" >&2
            return 1
        fi
        if curl --fail --silent --max-time 1 --output /dev/null \
            "http://${HTTP_ADDRESS:-127.0.0.1:18081}/ready"; then
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
    while kill -0 "$backend_test_pid" 2>/dev/null; do
        if [[ -n "$indexer_pid" ]] && ! kill -0 "$indexer_pid" 2>/dev/null; then
            printf 'The API container stopped during acceptance. Inspect the preceding service logs.\n' >&2
            return 1
        fi
        sleep 0.1
    done
    check_status=0
    wait "$backend_test_pid" || check_status=$?
    backend_test_pid=""
    return "$check_status"
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
    local container_id
    rm -f "$project_root/.local/indexer-failure" "$project_root/.local/container-exit"
    printf 'Starting the Go Indexer and read API container...\n'
    arena_compose up -d --no-deps --force-recreate api
    arena_compose logs --follow --since "$compose_log_since" db api &
    indexer_log_pid=$!
    container_id="$(arena_compose ps -q api)"
    if [[ -z "$container_id" ]]; then
        printf 'Compose did not create the API container.\n' >&2
        return 1
    fi
    docker wait "$container_id" > "$project_root/.local/container-exit" &
    indexer_pid=$!
}

restart_go_indexer() {
    [[ -f "$indexer_command_file" ]] || return
    arena_compose kill --signal USR1 api
}

stop_backend() {
    trap '' USR1
    stop_backend_tests
    arena_compose down || true
    if [[ -n "$indexer_log_pid" ]]; then
        kill -TERM "$indexer_log_pid" 2>/dev/null || true
        wait "$indexer_log_pid" 2>/dev/null || true
    fi
    if [[ -n "$indexer_pid" ]]; then
        kill -TERM "$indexer_pid" 2>/dev/null || true
        wait "$indexer_pid" 2>/dev/null || true
    fi
    stop_local_chain
    rm -f "$backend_pid_file" "$indexer_command_file"
}
