# On-chain Tactical Arena

A two-player on-chain tactical game in development. Each player commands three units on an 8x8 board, using hidden orders, simultaneous movement, combat, and objective control.

The current project provides a Vue/TypeScript page, Go command entry, map validation utility, Solidity protocol types and hashes, pure action validation and outcome rules, shared state/hash vectors, and a deployable Arena with room creation, joining, cancellation, expiry, and state queries. The backend launcher prepares a local chain and a two-account room demonstration. Playable battles, wallet integration, database services, and historical replay are planned.

## Game design

The planned game uses a fixed Guardian/Ranger/Scout squad. Players commit to hidden orders, reveal their orders and random salts, and let Solidity resolve movement, combat, resources, and victory. There is no NFT, token, staking, or real-asset economy.

The [map configuration](config/map.json) contains the 8x8 Arena layout, mirrored starting slots, resources, central control cells, ASCII, and bitmaps. Coordinates start at the upper-left corner; `cellId = y * 8 + x`. Each player's three actions follow squad slot order. Slots remain fixed after death, and dead units contribute HOLD.

| Unit | HP | MOVE limit | ATTACK | Special action |
|---|---:|---:|---|---|
| Guardian | 10 | 1 step | Orthogonally adjacent cell, damage 2 | SHIELD: 1 Energy; reduce this round's accumulated incoming damage by up to 2 |
| Ranger | 6 | 2 steps | Straight horizontal/vertical range 1-3, damage 2 | POWER_SHOT: 2 Energy; same targeting rules, damage 3 |
| Scout | 5 | 3 steps | Orthogonally adjacent cell, damage 1 | DASH: 1 Energy; move up to 4 steps |

Each live unit selects one action. Movement supplies a complete, nonempty orthogonal path, excluding the starting cell. Paths cannot cross obstacles, revisit a cell including their origin, or enter another live unit's starting cell. All moves sharing an endpoint fail; shared intermediate empty cells are allowed. HOLD means staying in place without attacking or spending Energy.

Attacks target cells within the attacker's range at round start. Empty targets are valid. Obstacles block Ranger rays; units do not. After movement, attacks hit only enemies occupying their target cells. Damage is simultaneous, including attacks from units killed that round, and HP cannot fall below zero. SHIELD reduces the Guardian's total accumulated damage once. Combined skill costs must fit the player's round-start Energy and remain spent when a move fails or a shot misses.

Players start with 0 Victory Points and 2 Energy, capped at 5 Energy. After deaths are removed, each occupied resource grants 1 Energy. The sole majority across the four central cells gains 2 Victory Points; equal counts gain none. Outcome priority is elimination, the 12-point threshold, then the 20-round limit. A sole surviving side wins; simultaneous elimination draws. At the point threshold or round limit, compare Victory Points, then surviving HP, then draw.

An unjoined room lasts 24 hours. A different address may join at or before its deadline. The creator may cancel while the room is waiting; anyone may expire it strictly after the deadline. Joining starts round 1. Commit and Reveal each have a 600-second window, opening the next phase as soon as both valid submissions arrive. Submissions are timely at the deadline; timeout finalization requires a later timestamp. One missing submission forfeits; two missing submissions draw, without executing a battle round. Anyone may finalize timeouts or settle a round with both valid reveals.

Commitments cannot be replaced. Invalid reveals can be retried before the deadline using the original committed data. Nonterminal settlement advances the round and opens a new Commit window. Match rules and map settings remain fixed throughout play. The current contract implements the room lifecycle through joining and entering Commit; action submission, Reveal, timeouts during battle, and round settlement remain to be implemented.

## Architecture

- **Solidity / Foundry:** authoritative room storage and lifecycle, plus pure action validation and outcome rules; movement, combat, and world updates remain planned.
- **Go / PostgreSQL:** planned indexing, reorg recovery, independent replay, read APIs, and public phase progression.
- **Vue 3 / TypeScript / Vite:** the application entry; Phaser 4, wallet integration, and historical replay follow in their implementation stages.

Players sign official writes with their own wallets. Backend services provide convenience and verification; they cannot override contract state or match outcomes.

## Contract protocol

[Arena](contracts/src/Arena.sol) stores matches and implements room creation, joining, cancellation, expiry, and queries. [GameTypes](contracts/src/GameTypes.sol) defines enums, action/state layouts, fixed rules, map data, and initial battle state. [GameHash](contracts/src/GameHash.sol) implements canonical encoding checks and hashing. [IArena](contracts/src/IArena.sol) declares the shared protocol signatures, events, and errors, including planned round operations.

[MapRules](contracts/src/MapRules.sol) implements coordinate conversion, bitmap queries, orthogonal paths, and wall-blocked straight rays. [UnitRules](contracts/src/UnitRules.sol) validates an entire three-action squad against the round-start snapshot and returns its total skill cost without changing state. It reuses the canonical encoding checks, enforces type-specific actions and ranges, blocks paths through live units' initial cells, requires dead slots to HOLD, and rejects Energy overspending. Shared empty endpoints remain valid at this step; the future resolver will handle movement conflicts. These libraries provide the validation entry for future Reveal and settlement calls.

[ResultRules](contracts/src/ResultRules.sol) evaluates a settlement candidate after damage, deaths, and scoring. Elimination takes priority over Victory Points, followed by the round limit. Points are compared before remaining total HP, with a draw on equality. Before a continuing round is advanced, the candidate's round identifies the round just resolved. The function returns an outcome and reason without changing the candidate, and preserves an existing terminal result, including protocol forfeits. The future resolver will call this library during settlement.

Each action has a kind, target cell, path length, and four path cells. Unused targets are 255; unused path entries are zero. Dead units retain their type and slot, with zero HP and cell 255. Hashes use Keccak-256 over standard ABI encoding. Action commitments bind chain, contract, match, round, player, rules, orders, and salt; generate and retain secrets locally before broadcasting.

The battle hash covers match context, rules, map, round, player resources, all six units, and outcome. Commitments, salts, phase flags, and deadlines are excluded. An ongoing state's round is the next round to resolve; a terminal state retains its final round. Timeout preserves the board and resources while updating the outcome and reason.

The [shared state vectors](config/state-vectors.json) contain the frozen rules hash, result candidates with expected outcomes/reasons, and complete hash states with fixed contexts and expected digests. Result candidates use the round being evaluated; hash states already use the next round when play continues. Hash cases cover the initial state, chain/contract/match isolation, a continuing state, canonical death, terminal draws, and protocol timeouts. Expected digests were generated offline using Cast's standard ABI encoder and Keccak-256. Solidity, Go, and TypeScript can consume the same data without relying on a running backend.

The backend launcher builds the contracts with the local compiler. The generated Arena artifact is the ABI source for the current deployment and later frontend/Go integration. Its internal [protocol check](contracts/script/CheckProtocol.s.sol) compares action encoding against Cast, checks commitment context binding, validates the initial state encoding, and checks rejection of noncanonical actions. The [static rule check](contracts/script/CheckRules.s.sol) covers map geometry, initial occupancy, movement limits and blocking, empty and invalid targets, skill restrictions, combined Energy costs, dead slots, and canonical fields. The [result/hash check](contracts/script/CheckResults.s.sol) reads the shared vectors with Foundry's typed JSON parser and compares production outcome/hash functions against the fixed expected values, including the initial-state factory. These checks run offline. The [room check](contracts/script/CheckArena.s.sol) verifies the deployed demonstration and exercises identity, phase, cancellation, expiry, and exact deadline boundaries in a disposable local fork.

## Local use

The current tool baseline is Node 22.23.2, npm 10.9.8, Go 1.25.3, Foundry 1.8.1, and Solidity 0.8.30. Install these tools before using the startup scripts. Keep the previously downloaded Solidity compiler in its existing local tools directory; the backend launcher uses it offline.

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

The backend launcher builds the contracts, runs the offline protocol, static rule, and result/hash checks, validates the map, starts Anvil, deploys Arena, and creates and joins match 1 with Anvil's first two development accounts. It then checks the room lifecycle and runs the current Go entry. These steps run automatically through this single entry point. Contract compilation uses the local compiler; deployment and room operations use the local RPC.

Keep port 8545 available. Each backend launch starts a fresh in-memory chain at http://127.0.0.1:8545 with chain ID 31337. The launcher prints the Arena address and deployment block. Match 1 ends the demonstration in Commit, with six initialized units and its initial state hash. The compiled Arena artifact provides its callable methods, events, and errors for direct RPC access.

Standard output and error output, including compilation and startup failures, appear in the terminal and are also written to a local log in the project root. Each invocation overwrites the previous log, which is excluded from the repository. Any failed step stops startup and shuts down the launcher's Anvil process. The Go application currently prints its development status and exits; it does not start HTTP, Indexer, or Keeper services. The launcher keeps the local chain running until Ctrl+C. Stopping it discards local chain state.

The frontend lockfile exists. Use npm ci for subsequent dependency installation. CI and the project LICENSE are deferred by the maintainer.

## Current limits

The local demonstration reaches the first Commit phase; battles and public testnet deployments remain planned. The page does not access a wallet, RPC, or database. No automated battle-test or independent security-audit result is claimed. Map geometry validation does not establish game balance.

Detailed design and implementation planning are maintained locally.
