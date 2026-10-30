#!/usr/bin/env bash
# Internal frontend acceptance, dispatched by the backend test mode.
prepare_frontend_checks() {
    if [[ ! -d "$project_root/client/node_modules/playwright" || ! -d "$project_root/client/node_modules/vite" ]]; then
        printf 'Browser acceptance requires the existing client dependencies. Prepare them in client/ before running test; nothing was installed.\n' >&2
        return 1
    fi
    node "$project_root/client/scripts/browser.mjs"
    printf "Database restart acceptance controls only this project's PostgreSQL container.\n"
}

run_frontend_checks() {
    cd "$project_root/client"
    printf 'Checking frontend formatting, typed ABI usage, and production compilation...\n'
    run_backend_check npm run format:check
    run_backend_check npm run typecheck
    run_backend_check npm run build
    printf 'Running two-account browser gameplay, order recovery, and timeout acceptance...\n'
    run_backend_check node "$project_root/client/scripts/check-gameplay.mjs"
    printf 'Running browser reconnection, automatic refresh, and database restart acceptance...\n'
    run_backend_check node "$project_root/client/scripts/check-updates.mjs"
    printf 'Checking saved-chain restart, deployment reuse, original order secrets, and historical rebuild...\n'
    run_backend_check node "$project_root/client/scripts/check-persistence.mjs"
}
