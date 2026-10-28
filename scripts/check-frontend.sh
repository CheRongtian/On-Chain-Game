#!/usr/bin/env bash
# Internal browser acceptance checks, dispatched by the backend test mode.
run_frontend_checks() {
    cd "$project_root/client"
    printf 'Preparing frontend acceptance dependencies...\n'
    npm install --no-audit --no-fund
    npm run typecheck
    printf 'Running browser history and replay acceptance checks...\n'
    run_backend_check node "$project_root/client/scripts/check-history.mjs"
}
