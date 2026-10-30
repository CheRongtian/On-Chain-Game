#!/usr/bin/env bash
# Internal offline safety work; the backend test entry owns logging and process cleanup.
run_safety_checks() {
    local evidence="$project_root/.local/safety" fuzz_target
    mkdir -p "$evidence"
    printf '{"status":"running","stage":"contracts"}\n' > "$evidence/acceptance.json"
    forge --version > "$evidence/toolchain.txt"
    GOTOOLCHAIN=local go version >> "$evidence/toolchain.txt"
    cp "$project_root/contracts/foundry.toml" "$evidence/foundry.toml"
    printf 'Checking Solidity formatting...\n'
    cd "$project_root/contracts"
    if ! run_backend_check forge fmt --check; then
        printf '{"status":"failed","stage":"contract-format"}\n' > "$evidence/acceptance.json"
        return 1
    fi
    printf 'Running local contract state-machine, replay, deadline, and legal-game checks...\n'
    if ! run_backend_check forge test --offline --use "$project_root/.local/bin/solc-0.8.30" \
        --no-match-contract ArenaGasTest -vv; then
        printf '{"status":"failed","stage":"contracts"}\n' > "$evidence/acceptance.json"
        return 1
    fi
    printf 'Recording reachable dense-combat, maximum-round, timeout, and storage-access gas samples...\n'
    if ! run_backend_check forge snapshot --offline --use "$project_root/.local/bin/solc-0.8.30" \
        --isolate --match-contract ArenaGasTest --snap "$evidence/gas.snapshot" -vv; then
        printf '{"status":"failed","stage":"gas"}\n' > "$evidence/acceptance.json"
        return 1
    fi
    cd "$project_root/server"
    printf 'Checking all Go packages, rejection cases, and seeded rule invariants with existing dependencies...\n'
    if ! run_backend_check env GOTOOLCHAIN=local GOPROXY=off go test -mod=readonly ./...; then
        printf '{"status":"failed","stage":"go-cases"}\n' > "$evidence/acceptance.json"
        return 1
    fi
    for fuzz_target in FuzzGeneratedGames FuzzActionInput; do
        printf 'Running Go %s with native failure shrinking...\n' "$fuzz_target"
        if ! run_backend_check env GOTOOLCHAIN=local GOPROXY=off go test -mod=readonly \
            -run '^$' -fuzz "^${fuzz_target}$" -fuzztime=5s -parallel=1 ./internal/offline; then
            printf '{"status":"failed","stage":"go-fuzz","target":"%s"}\n' "$fuzz_target" > "$evidence/acceptance.json"
            return 1
        fi
    done
    printf 'Comparing independent Go/Solidity sequences and collecting measured gas evidence...\n'
    run_backend_check "$indexer_binary" safety
}
