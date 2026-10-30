#!/usr/bin/env bash
# Sourced by the backend launcher after its shared environment and logging setup.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    printf 'Run ./scripts/run-backend.sh test to execute backend checks.\n' >&2
    exit 1
fi

existing_backend_pid=""

backend_running_for_checks() {
    [[ -f "$backend_pid_file" ]] || return 1
    read -r existing_backend_pid < "$backend_pid_file" || return 1
    [[ "$existing_backend_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_backend_pid" 2>/dev/null
}

run_indexer_checks() {
    cd "$project_root/server"
    if [[ "${1:-}" == "demo" ]]; then
        printf 'Creating and independently verifying two demo matches...\n'
    else
        printf 'Running indexing, replay, and recovery acceptance checks...\n'
    fi
    if [[ -n "${1:-}" ]]; then
        run_backend_check "$indexer_binary" check-indexer "$1"
    else
        run_backend_check "$indexer_binary" check-indexer
    fi
}
