#!/usr/bin/env bash
# Internal recovery acceptance, dispatched by the backend test mode.
prepare_frontend_checks() {
    if [[ ! -d "$project_root/client/node_modules/playwright" || ! -d "$project_root/client/node_modules/vite" ]]; then
        printf 'Browser acceptance requires the existing client dependencies. Prepare them in client/ before running test; nothing was installed.\n' >&2
        return 1
    fi
    node "$project_root/client/scripts/browser.mjs"
    if [[ ! -f /Library/LaunchDaemons/postgresql-16.plist ]]; then
        printf 'The existing PostgreSQL 16 LaunchDaemon is required for database restart acceptance.\n' >&2
        return 1
    fi
    if ! /usr/bin/sudo -n -l /bin/launchctl kill SIGINT system/postgresql-16 > /dev/null 2>&1 ||
       ! /usr/bin/sudo -n -l /bin/launchctl kickstart system/postgresql-16 > /dev/null 2>&1 ||
       ! /usr/bin/sudo -n /bin/launchctl print system/postgresql-16 > /dev/null 2>&1; then
        printf 'Password-free PostgreSQL test control is unavailable. Apply the one-time fixed-command setup in the root README before running test.\n' >&2
        return 1
    fi
    printf 'PostgreSQL test control is available. Test will briefly restart the shared service and disconnect its clients.\n'
}

run_frontend_checks() {
    cd "$project_root/client"
    printf 'Running browser reconnection, automatic refresh, and database restart acceptance...\n'
    run_backend_check node "$project_root/client/scripts/check-updates.mjs"
}
