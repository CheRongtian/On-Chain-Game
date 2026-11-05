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
    printf 'Checking Go backend build inputs; unchanged compiler work is reused...\n'
    GOTOOLCHAIN=local GOPROXY=off go build -mod=readonly -o "$indexer_binary" ./cmd/arena-server
    printf 'Checking the local Geth build with cached dependencies...\n'
    if ! GOTOOLCHAIN=local GOPROXY=off go build -mod=readonly -o "$project_root/.local/bin/arena-chain" ./cmd/arena-chain; then
        printf 'Full-node dependencies are incomplete. Prepare them once with cd server && go mod tidy, then start the backend again.\n' >&2
        return 1
    fi
}

build_linux_backend() {
    cd "$project_root/server"
    printf 'Checking Linux backend inputs for %s with the installed Go and compiler cache...\n' "$ARENA_API_PLATFORM"
    GOTOOLCHAIN=local GOPROXY=off CGO_ENABLED=0 GOOS=linux GOARCH="${ARENA_API_PLATFORM#linux/}" \
        go build -trimpath -buildvcs=false -mod=readonly -o "$project_root/.local/bin/arena-server-linux" ./cmd/arena-server
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
    arena_compose up -d --no-deps --no-build api
    node "$project_root/scripts/client-contract.mjs" follow-logs "$compose_log_since" &
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
    local operation
    read -r operation < "$indexer_command_file"
    if [[ "$operation" == "reload-chain" && "$mode" == "test" ]]; then
        rm -f "$indexer_command_file"
        printf 'Acceptance: restoring the isolated %s node and its original deployment...\n' "$local_chain_engine"
        stop_local_chain
        start_local_chain
        deploy_local_arena
        printf 'restart\n' > "$indexer_command_file"
        arena_compose kill --signal USR1 api
        wait_for_backend_ready "$indexer_pid"
        return
    fi
    arena_compose kill --signal USR1 api
}

stop_go_indexer() {
    arena_compose stop api
    if [[ -n "$indexer_log_pid" ]]; then
        kill -TERM "$indexer_log_pid" 2>/dev/null || true
        wait "$indexer_log_pid" 2>/dev/null || true
        indexer_log_pid=""
    fi
    if [[ -n "$indexer_pid" ]]; then
        wait "$indexer_pid" 2>/dev/null || true
        indexer_pid=""
    fi
    compose_log_since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

stop_backend() {
    local backend_status=$?
    trap '' USR1
    stop_backend_tests
    if [[ "$mode" == "test" ]]; then
        arena_compose down --volumes || backend_status=1
    else
        arena_compose stop || backend_status=1
    fi
    if [[ -n "$indexer_log_pid" ]]; then
        kill -TERM "$indexer_log_pid" 2>/dev/null || true
        wait "$indexer_log_pid" 2>/dev/null || true
    fi
    if [[ -n "$indexer_pid" ]]; then
        kill -TERM "$indexer_pid" 2>/dev/null || true
        wait "$indexer_pid" 2>/dev/null || true
    fi
    if ! stop_local_chain; then backend_status=1; fi
    rm -f "$backend_pid_file" "$indexer_command_file"
    if [[ "$mode" == "test" ]]; then
        if [[ "$backend_status" == 0 && -f "$project_root/.local/acceptance.json" ]]; then
            node "$project_root/scripts/baseline.mjs" retain || backend_status=1
        fi
        if [[ "$backend_status" == 0 && -f "$project_root/.local/acceptance.json" ]]; then
            printf 'PASS: complete automated acceptance, squad rules, map geometry, browser-engine coverage, operational recovery, all four Geth archive requirements and service cleanup. The local release still requires the recorded manual walkthrough.\n'
        else
            backend_status=1
            printf '{"status":"failed","exitCode":%d}\n' "$backend_status" > "$project_root/.local/acceptance.json"
            node "$project_root/scripts/release.mjs" record-outcome || backend_status=1
            printf 'FAIL: complete acceptance did not finish. Earlier stage PASS messages do not establish overall completion.\n' >&2
        fi
    fi
    trap - EXIT
    exit "$backend_status"
}
