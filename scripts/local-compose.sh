#!/usr/bin/env bash
# Internal Compose operations shared by the two launchers and acceptance tools.
arena_compose() {
    docker compose --project-name onchain-arena --project-directory "$project_root" \
        -f "$project_root/compose.yaml" "$@"
}

configure_local_database() {
    export ARENA_DATABASE_PORT="${ARENA_DATABASE_PORT:-55432}"
    export ARENA_DATABASE_PASSWORD="${ARENA_DATABASE_PASSWORD:-arena_local}"
    if [[ ! "$ARENA_DATABASE_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || (( ARENA_DATABASE_PORT > 65535 )); then
        printf 'ARENA_DATABASE_PORT must be a TCP port from 1 to 65535.\n' >&2
        return 1
    fi
    export DATABASE_URL="postgres://arena@127.0.0.1:$ARENA_DATABASE_PORT/onchain_arena?sslmode=disable"
    export PGPASSWORD="$ARENA_DATABASE_PASSWORD"
}

require_compose() {
    if ! command -v docker >/dev/null 2>&1; then
        printf 'Docker is required. Start the existing Docker Desktop installation or prepare it before launching.\n' >&2
        return 1
    fi
    docker compose version >/dev/null
    if ! docker info >/dev/null 2>&1; then
        printf 'Docker Desktop is not ready. Start it, wait until its engine is running, and run this command again.\n' >&2
        return 1
    fi
}

require_local_images() {
    local image
    for image in ubuntu:24.04 postgres:16-alpine; do
        if ! docker image inspect "$image" >/dev/null 2>&1; then
            printf 'Required local image is missing: %s. Prepare it with docker pull %s, then run this launcher again.\n' "$image" "$image" >&2
            return 1
        fi
    done
    ARENA_API_PLATFORM="linux/$(docker image inspect --format '{{.Architecture}}' ubuntu:24.04)"
    export ARENA_API_PLATFORM
}

reset_local_demo() {
    local answer managed_pid deadline
    printf "Reset will remove this project's Compose containers and database volume, contract build output, published deployment, and local demo/acceptance reports.\n"
    printf 'The local environment, downloaded tools, and macOS PostgreSQL installation are retained.\n'
    read -r -p 'Type reset to continue: ' answer
    if [[ "$answer" != "reset" ]]; then
        printf 'Reset cancelled.\n'
        return
    fi
    if [[ -f "$backend_pid_file" ]]; then
        read -r managed_pid < "$backend_pid_file"
        if [[ "$managed_pid" =~ ^[0-9]+$ ]] && kill -0 "$managed_pid" 2>/dev/null; then
            kill -TERM "$managed_pid"
            deadline=$((SECONDS + 60))
            while kill -0 "$managed_pid" 2>/dev/null; do
                if (( SECONDS >= deadline )); then
                    printf 'The managed backend did not finish cleanup. Stop it before resetting.\n' >&2
                    return 1
                fi
                sleep 0.2
            done
        fi
    fi
    if [[ -f "$project_root/.local/anvil.pid" ]]; then
        read -r managed_pid < "$project_root/.local/anvil.pid"
        if [[ "$managed_pid" =~ ^[0-9]+$ ]] && lsof -nP -a -p "$managed_pid" -iTCP:18545 -sTCP:LISTEN >/dev/null 2>&1; then
            kill -CONT "$managed_pid" 2>/dev/null || true
            kill -TERM "$managed_pid"
        fi
    fi
    arena_compose down --volumes
    rm -rf "$project_root/.local/indexer" "$project_root/.local/browser" "$project_root/.local/demo" \
        "$project_root/contracts/out" "$project_root/contracts/cache" "$project_root/contracts/broadcast"
    rm -f "$backend_pid_file" "$indexer_command_file" "$project_root/.local/indexer-failure" \
        "$project_root/.local/anvil.pid" "$project_root/.local/container-exit" \
        "$project_root/client/public/deployment.json"
    printf 'Local demo data reset. Run the backend normally or with demo to initialize it again.\n'
}
