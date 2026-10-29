#!/usr/bin/env bash
# Internal recovery acceptance, dispatched by the backend test mode.
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
    printf 'Running browser reconnection, automatic refresh, and database restart acceptance...\n'
    run_backend_check node "$project_root/client/scripts/check-updates.mjs"
}
