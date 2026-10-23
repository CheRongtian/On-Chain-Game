# On-chain Tactical Arena

A two-player on-chain tactical game in development. Each player commands three units on an 8x8 board, using hidden orders, simultaneous movement, combat, and objective control.

The current project provides a Vue/TypeScript page, Go command entry, Foundry compilation skeleton, gameplay specifications, and a map validation utility. Playable matches, wallet integration, authoritative battle contracts, database services, and historical replay are planned.

## Game design

The game uses a fixed Guardian/Ranger/Scout squad. Players commit to hidden orders, reveal their orders and random salts, and let Solidity resolve movement, combat, resources, and victory. There is no NFT, token, staking, or real-asset economy. Map geometry, unit actions, scoring, room lifecycle, and submission deadlines are specified; exact byte encoding remains to be finalized.

## Architecture

- **Solidity / Foundry:** planned authoritative state machine and deterministic battle resolution.
- **Go / PostgreSQL:** planned indexing, reorg recovery, independent replay, read APIs, and public phase progression.
- **Vue 3 / TypeScript / Vite:** the application entry; Phaser 4, wallet integration, and historical replay follow in their implementation stages.

Players sign official writes with their own wallets. Backend services provide convenience and verification; they cannot override contract state or match outcomes.

## Local use

The current tool baseline is Node 22.23.2, npm 10.9.8, Go 1.25.3, Foundry 1.8.1, and Solidity 0.8.30. Install these tools before using the startup scripts. Foundry can use a matching local Solidity compiler when automatic downloading is unavailable.

Install frontend dependencies once:

```
cd client
npm install --no-audit --no-fund
```

For daily use, run one script in each of two terminals at the project root.

Frontend:

```
./scripts/run-frontend.sh
```

Open the local address printed by Vite, normally http://127.0.0.1:5173. The page currently displays the project name and availability notice.

Backend:

```
./scripts/run-backend.sh
```

The backend launcher first validates the map, then runs the current Go entry. Standard output and error output, including compilation and startup failures, go to a local log in the project root. Each invocation overwrites the previous log, which is excluded from the repository. A map validation failure stops startup. The Go application currently prints its development status and exits; it does not start HTTP, Indexer, or Keeper services.

The frontend lockfile exists. Use npm ci for subsequent dependency installation. CI and the project LICENSE are deferred by the maintainer. Local docs remain local under the existing ignore rules.

## Current limits

There are no playable matches, deployed game contracts, or public testnet addresses. The page does not access a wallet, RPC, or database. No automated battle-test or independent security-audit result is claimed. Map geometry validation does not establish game balance.

Detailed design, implementation planning, and development records are maintained locally.
