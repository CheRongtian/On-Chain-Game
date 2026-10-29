#!/bin/sh
# Keep acceptance clients connected to the container while Go itself restarts.
set -u

command_file=/workspace/.local/indexer-command
failure_file=/workspace/.local/indexer-failure
server_pid=""
operation=""
restarts=0
restart_window=$(date +%s)
rm -f "$failure_file"

start_server() {
    if [ -n "$operation" ]; then
        arena-server serve "$operation" &
    else
        arena-server serve &
    fi
    server_pid=$!
}

stop_server() {
    trap '' INT TERM USR1
    if [ -n "$server_pid" ]; then
        kill -CONT "$server_pid" 2>/dev/null || true
        kill -TERM "$server_pid" 2>/dev/null || true
        wait "$server_pid" 2>/dev/null || true
    fi
    exit 0
}

restart_server() {
    [ -f "$command_file" ] || return
    read -r requested < "$command_file" || return
    case "$requested" in
        restart) operation="" ;;
        rescan|reindex) operation="$requested" ;;
        *) printf 'Unknown indexing operation: %s\n' "$requested" >&2; return ;;
    esac
    rm -f "$command_file"
    printf 'Restarting Go services inside the existing container; Anvil and rooms remain running.\n'
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    while kill -0 "$server_pid" 2>/dev/null; do
        sleep 0.1
    done
    start_server
}

trap stop_server INT TERM
trap restart_server USR1
start_server
while true; do
    observed_pid="$server_pid"
    if kill -0 "$observed_pid" 2>/dev/null; then
        if [ -n "$operation" ] && arena-server check-ready 2>/dev/null; then
            operation=""
        fi
        sleep 1 &
        wait $! || true
        continue
    fi
    server_status=0
    wait "$observed_pid" || server_status=$?
    [ "$observed_pid" = "$server_pid" ] || continue
    if [ -n "$operation" ]; then
        printf 'Go indexing maintenance failed with status %s. Inspect the comparison report.\n' "$server_status" | tee "$failure_file" >&2
        exit 1
    fi
    now=$(date +%s)
    if [ $((now - restart_window)) -ge 60 ]; then
        restarts=0
        restart_window=$now
    fi
    if [ "$restarts" -ge 3 ]; then
        printf 'Go recovery failed repeatedly. Inspect the preceding errors.\n' | tee "$failure_file" >&2
        exit 1
    fi
    restarts=$((restarts + 1))
    printf 'Go exited with status %s. Keeping the chain and container; recovery attempt %s/3.\n' "$server_status" "$restarts" >&2
    sleep 1
    start_server
done
