# On-chain Tactical Arena

A two-player on-chain tactical game in development. Each player commands three units on an 8x8 board, using hidden orders, simultaneous movement, combat, and objective control.

The current project provides a Vue/TypeScript local-account lobby, room creation/joining, host-controlled game starts, live room details, a Phaser battlefield with local action planning and browser Commit/Reveal rounds, independent Go rules and hashing, deterministic offline simulation, PostgreSQL event indexing, a read API, and an Arena with authoritative settlement and timeout handling. The browser uses Anvil's unlocked development accounts for real local-chain transactions. Players create rooms, take seats, and start games through explicit controls. The browser saves orders before Commit, restores Reveal after refresh, supports encrypted order backups, continues confirmed rounds automatically, and provides manual timeout controls. External wallet integration and independently verified historical replay remain planned.

## Game design

The game uses a fixed Guardian/Ranger/Scout squad. Players commit to hidden orders, reveal their orders and random salts, and let Solidity resolve movement, combat, resources, and victory. There is no NFT, token, staking, or real-asset economy.

The [map configuration](config/map.json) contains the 8x8 Arena layout, mirrored starting slots, resources, central control cells, ASCII, and bitmaps. Coordinates start at the upper-left corner; `cellId = y * 8 + x`. Each player's three actions follow squad slot order. Slots remain fixed after death, and dead units contribute HOLD.

| Unit     |  HP | MOVE limit | ATTACK                                           | Special action                                                               |
| -------- | --: | ---------: | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Guardian |  10 |     1 step | Orthogonally adjacent cell, damage 2             | SHIELD: 1 Energy; reduce this round's accumulated incoming damage by up to 2 |
| Ranger   |   6 |    2 steps | Straight horizontal/vertical range 1-3, damage 2 | POWER_SHOT: 2 Energy; same targeting rules, damage 3                         |
| Scout    |   5 |    3 steps | Orthogonally adjacent cell, damage 1             | DASH: 1 Energy; move up to 4 steps                                           |

Each live unit selects one action. Movement supplies a complete, nonempty orthogonal path, excluding the starting cell. Paths cannot cross obstacles, revisit a cell including their origin, or enter another live unit's starting cell. All moves sharing an endpoint fail; shared intermediate empty cells are allowed. HOLD means staying in place without attacking or spending Energy.

Attacks target cells within the attacker's range at round start. Empty targets are valid. Obstacles block Ranger rays; units do not. After movement, attacks hit only enemies occupying their target cells. Damage is simultaneous, including attacks from units killed that round, and HP cannot fall below zero. SHIELD reduces the Guardian's total accumulated damage once. Combined skill costs must fit the player's round-start Energy and remain spent when a move fails or a shot misses.

Players start with 0 Victory Points and 2 Energy, capped at 5 Energy. After deaths are removed, each occupied resource grants 1 Energy. The sole majority across the four central cells gains 2 Victory Points; equal counts gain none. Outcome priority is elimination, the 12-point threshold, then the 20-round limit. A sole surviving side wins; simultaneous elimination draws. At the point threshold or round limit, compare Victory Points, then surviving HP, then draw.

A waiting room lasts 24 hours. Its creator is the host. A different address may take the second seat at or before the room deadline, without starting the battle. Only the host can start a full room while it is still valid. Starting initializes the board, opens round 1, and starts the Commit timer. The host may cancel any room that has not started, including a full room; anyone may expire a waiting room strictly after the deadline. Commit and Reveal each have a 600-second window, opening the next phase as soon as both valid submissions arrive. Submissions are timely at the deadline; timeout finalization requires a later timestamp. One missing submission forfeits; two missing submissions draw, without executing a battle round. Anyone may finalize timeouts or settle a round with both valid reveals.

Commitments cannot be replaced. Invalid reveals can be retried before the deadline using the original committed data. Both valid reveals enter Resolvable, allowing anyone to settle that round once. Nonterminal settlement advances the round, clears old commitments and revealed orders, and opens a new Commit window. Terminal settlement preserves the final round and closes the match permanently. Match rules and map settings remain fixed throughout play.

## Architecture

- **Solidity / Foundry:** authoritative room and turn protocol storage, pure battle resolution, atomic settlement, and complete matches.
- **Go / PostgreSQL:** independent offline rules, encoding, hashing, simulation, transactional event indexing, and a read API. Automatic reorg recovery, independently verified historical replay, and Keeper progression remain planned.
- **Vue 3 / TypeScript / Vite / Phaser:** Router, Pinia, Viem, a local-account lobby, room and battlefield state read directly from RPC, local action drafts, persistent round secrets, one squad confirmation per round, and confirmed result animations. External wallets and historical replay follow.

The local browser sends transactions through Anvil's unlocked accounts, with signing performed by the node. The contract uses each transaction sender to identify its player. External wallet signing remains planned. Backend services provide convenience and verification; they cannot override contract state or match outcomes.

## Contract protocol

[Arena](contracts/src/Arena.sol) stores matches and exposes room operations, Commit/Reveal, public round settlement, timeout finalization, and queries. [GameTypes](contracts/src/GameTypes.sol) defines enums, action/state layouts, fixed rules, map data, and initial battle state. [GameHash](contracts/src/GameHash.sol) implements canonical encoding checks and hashing. [IArena](contracts/src/IArena.sol) declares the shared protocol signatures, events, and errors.

[TurnProtocol](contracts/src/TurnProtocol.sol) runs internally within Arena. Commit stores each player's immutable hash and submission flag; the second Commit opens a fresh Reveal window. Reveal checks the current player, round, deadline, complete commitment context, and squad legality before storing accepted actions and emitting their public payload. The second valid Reveal enters Resolvable with no phase deadline. Failed submissions revert their state and events. Anyone may finalize an expired Commit or Reveal phase: a sole submitter wins and bilateral absence draws. Timeout updates the terminal outcome, reason, and battle hash while preserving the board, resources, and round; it emits PhaseAdvanced and MatchFinished.

Settlement passes the accepted round-start state and both revealed squads to BattleResolver, then atomically stores the resulting battle, summary, and canonical state hash. RoundResolved identifies the settled round and carries the before/after hashes, resulting player resources, outcome, and reason. A continuing result already contains the next round number; TurnProtocol clears the previous inputs and emits PhaseAdvanced with a fresh 600-second Commit deadline. A terminal result emits PhaseAdvanced and MatchFinished with no deadline, retaining the final submission record. Finished matches reject further writes. MatchStarted and ActionRevealed expose the initial state and accepted orders/salts needed to reconstruct settlement results. For a timeout, replay retains the preceding board, resources, and round, applies the outcome/reason from MatchFinished, and verifies its state hash; that transition emits no RoundResolved.

[MapRules](contracts/src/MapRules.sol) implements coordinate conversion, bitmap queries, orthogonal paths, and wall-blocked straight rays. [UnitRules](contracts/src/UnitRules.sol) validates an entire three-action squad against the round-start snapshot and returns its total skill cost without changing state. It reuses the canonical encoding checks, enforces type-specific actions and ranges, blocks paths through live units' initial cells, requires dead slots to HOLD, and rejects Energy overspending. Shared empty endpoints remain valid during static validation. TurnProtocol uses these checks when accepting a Reveal, and BattleResolver reuses them before resolving movement conflicts.

[ResultRules](contracts/src/ResultRules.sol) evaluates a settlement candidate after damage, deaths, and scoring. Elimination takes priority over Victory Points, followed by the round limit. Points are compared before remaining total HP, with a draw on equality. Before a continuing round is advanced, the candidate's round identifies the round just resolved. The function returns an outcome and reason without changing the candidate, and preserves an existing terminal result, including protocol forfeits. BattleResolver uses it after world updates.

[BattleResolver](contracts/src/BattleResolver.sol) takes an ongoing battle snapshot and both action squads, validates both against the unchanged input, and produces an independent next state and ResolutionSummary. It deducts skill costs, cancels every move in a shared-endpoint group, resolves all target-cell attacks on the moved board, applies aggregate shielding and damage, removes deaths, awards resources/control, and evaluates the result. All attacks contribute before any HP is deducted. Continuing output states advance the round; terminal outputs retain the resolved round. The summary follows fixed player/unit slot order and records Energy spent, successful moves, actual HP lost, credited Energy after caps, and Victory Points gained. The input snapshot and action arrays remain unchanged.

Each action has a kind, target cell, path length, and four path cells. Unused targets are 255; unused path entries are zero. Dead units retain their type and slot, with zero HP and cell 255. Hashes use Keccak-256 over standard ABI encoding. Action commitments bind chain, contract, match, round, player, rules, orders, and salt; generate and retain secrets locally before broadcasting.

The battle hash covers match context, rules, map, round, player resources, all six units, and outcome. Commitments, salts, phase flags, and deadlines are excluded. An ongoing state's round is the next round to resolve; a terminal state retains its final round. Timeout preserves the board and resources while updating the outcome and reason.

The [shared state vectors](config/state-vectors.json) contain the frozen rules hash, result candidates with expected outcomes/reasons, and complete hash states with fixed contexts and expected digests. Result candidates use the round being evaluated; hash states already use the next round when play continues. Hash cases cover the initial state, chain/contract/match isolation, a continuing state, canonical death, terminal draws, and protocol timeouts. Expected digests were generated offline using Cast's standard ABI encoder and Keccak-256. Solidity, Go, and TypeScript can consume the same data without relying on a running backend.

The [shared battle vectors](config/battle-vectors.json) contain complete input snapshots, both action squads, explicit expected next states and summaries, and fixed expected battle hashes. They cover shared endpoints and paths, moving targets, empty/friendly targets, rays through units, aggregate shielding, simultaneous deaths, overkill, resource income/caps, control ties, victory priority, and the final round. Their expected states and summaries are authored per case, with digests generated offline using Cast. Central control awards points to only one side per round; comparisons with both players already at the threshold remain covered by the state vectors.

The backend launcher builds the contracts with the local compiler and deploys Arena. It leaves the room registry empty. Development fixtures and the demonstration runner remain in the source tree for contract work; the daily launcher does not invoke them or send room and turn transactions.

## Go rules and offline tools

The [Go rule package](server/internal/game/types.go) implements fixed state and action types, canonical validation, legal paths and targets, squad Energy budgets, simultaneous round resolution, outcomes, static ABI encoding, and protocol Keccak-256 hashing. It uses value copies of fixed arrays and has no RPC, wallet, database, or process dependency. The simulator and future replay service share these rules. Go predictions and simulations have no authority over official on-chain games.

The [vector runner](server/internal/offline/vectors.go) reads the existing 18 outcome cases, 12 state hashes, and 20 battle cases. The [protocol vectors](config/protocol-vectors.json) add 13 fixed action-encoding, ActionsHash, and Commitment references generated offline with Viem's standard ABI encoder and Keccak-256. They cover all action kinds, context isolation, round and player binding, and Salt boundaries. Expected values are committed data and are not generated by the Go implementation during verification. Differences identify the case, field, expected value, and actual value.

Run the fixed-vector comparison from the project root:

```
./scripts/run-backend.sh verify
```

This mode compares Go with the fixed references, then runs the existing Solidity outcome and battle checks and the new protocol comparison inside Forge's offline EVM. It requires neither Anvil nor PostgreSQL. The backend script uses `go run -mod=mod` for offline commands and `go build -mod=mod` for normal startup. Go downloads missing build dependencies and maintains its dependency records as needed, reusing successfully cached downloads on subsequent runs. Routine startup does not run `go mod tidy`, which also resolves dependencies used by upstream tests and other platforms.

Run deterministic multi-round simulation and differential comparison:

```
./scripts/run-backend.sh simulate --seed 42 --games 10
```

The [generator](server/internal/game/generate.go) enumerates legal actions in a fixed order and uses an explicitly seeded random source. Each squad stays within its round-start Energy budget. Generated games run to a contract-rule terminal result, and the same seed and game count produce the same complete input/output records. Timing and throughput are reported separately from deterministic records. The [offline Solidity comparator](contracts/script/CompareRules.s.sol) independently resolves every generated input and compares all state fields, summary fields, and StateHash. It runs in a local EVM with no RPC or broadcast. A difference or Solidity rejection stops the command with the failing seed/case and a single-round reproduction containing its full start state, context, and both squads. To replay a saved failure, pass its printed reproduction filename through the simulation mode's `--input` option. Run records and reproduction files stay in the ignored local working area.

Both offline modes use the existing backend script and overwrite the same root log while displaying output in the terminal. They run before chain startup logic, so selecting one does not start or deploy a chain, clear the published deployment, or create game transactions. The default backend mode continues to prepare the local chain and wait for browser operations; it does not run batch simulation. The first dependency preparation may need network access; the rule calculations and Solidity reference execution are offline once tools and dependencies are available. Runtime comparison results and performance baselines must be established by the maintainer when invoking these modes.

## Local account lobby

The [lobby](client/src/views/LobbyView.vue) creates rooms using the selected local account and opens existing rooms by ID or a copied invitation URL from the same application. Copy invitation produces a link that can be pasted into Find a room or opened directly in another tab. Creation obtains the actual ID from the confirmed MatchCreated event. The [room view](client/src/views/RoomView.vue) reads players, phase, round, deadlines, and result directly from Arena. A different local account can take the open seat in a waiting room. Both accounts remain in the preparation room until its host presses Start game. The contract rejects starts by other accounts, starts without an opponent, full-room joins, repeated starts, and starts after the room deadline. The room page reads the chain every second and automatically takes its seated accounts to the battlefield after a confirmed start, including when an already-started invitation is reopened.

The account bar reads unlocked accounts and balances from Anvil through Viem's [JSON-RPC wallet client](https://viem.sh/docs/clients/wallet). The page stores the selected address in session storage, independently for each browser tab. Switching accounts returns the current tab to the lobby and clears its room view, form input/errors, invitation feedback, and transaction notices. A directly opened invitation remains on its room page during initial account loading. Room roles follow the creator and opponent recorded by the contract. The node signs transactions, and the browser displays their pending, confirmed, or failed status. Deployment changes clear the transaction context and refresh the current room.

The [synchronization helper](scripts/client-contract.mjs) exports the [typed ABI](client/src/generated/arena.ts) from the compiler artifact. After Arena is deployed, the backend publishes public connection information for the browser and removes it when its node stops. Deployment timestamps distinguish fresh local sessions when the deterministic Arena address repeats. The frontend supplies connection feedback, inline room-ID errors, retry actions, disabled submission states, and responsive layouts. This workflow requires no Go API, wallet extension, private-key import, or manually entered deployment address.

## Battlefield and action planning

The preparation room keeps Start game visible to its host from creation onward. It is disabled until an opponent joins, and joining only takes the second seat. The host explicitly starts the game; the contract then initializes the battlefield and first Commit deadline. Both room pages automatically enter the battle after confirmation. The browser checks the MatchStarted transaction sender against the room host before entering, so an older local deployment that starts on join produces an actionable restart message. A direct battle link before the host starts returns to the preparation room.

The [battlefield view](client/src/views/BattleView.vue) owns a dedicated game layout with a compact account and room header, player resources, the board, and three order summaries. Its layout is independent of the lobby shell. The [Phaser renderer](client/src/battlefield/BattlefieldScene.ts) draws confirmed terrain and units from the chain. Vue receives tile selections through the [typed bridge](client/src/battlefield/bridge.ts). The board uses one fixed logical coordinate system; Phaser fits its canvas inside a stable container, and keyboard tile controls align to the actual canvas bounds. Opening or closing unit details never changes that container.

Click a unit to open its [side drawer](client/src/components/UnitActionDrawer.vue). Player A units always open it on the left; Player B units always open it on the right, following their spawn side even after movement. It shows confirmed stats, the current local order, and actions with their Energy costs. The drawer is compact, capped below a quarter of the game viewport width, and bounded by its height. A dark backdrop dims the rest of the game and blocks background interaction. The close button, backdrop, and Escape dismiss it. Native modal focus stays within the drawer while it is open. Opponent and defeated units expose information only.

Choose Move or Dash to close the drawer, remove the backdrop, and highlight reachable destinations. Clicking a destination previews a shortest legal path; Attack and Power shot highlight legal target tiles instead. The target controls occupy a reserved area below the board. Confirm replaces the selected unit's local draft after geometry and shared Energy checks pass, then reopens its drawer. For Move and Dash, the full piece moves to the saved destination as a pink DRAFT preview while a faint START marker remains at its confirmed origin. An unconfirmed target remains a planning outline. Both the preview piece and its start marker can be selected. Shared draft destinations show smaller stacked pieces; repeated tile selections cycle through them. Cancel reopens the drawer with its original draft. Hold and Shield can be reviewed and confirmed within the drawer. Closing details retains saved drafts; Reset to Hold clears one unit's draft, and Undo restores the previous saved order and its displayed position. Defeated slots retain Hold.

The [planning helpers](client/src/lib/battle.ts) follow round-start path geometry, occupancy, wall blocking, range, skills, and Energy rules. Empty and friendly attack targets remain legal. Moves may share intermediate empty tiles; identical destinations remain legal orders even though those moves fail at settlement. Valid bundles use three actions in squad slot order, target 255 where unused, and zero-padded four-cell paths. Local previews do not calculate authoritative movement, damage, income, or victory.

The [battle store](client/src/stores/battle.ts) keeps confirmed snapshots separate from saved drafts and the pending selection. All battlefield getters are pinned to one block. Team-colored units and resources show chain data; pink pieces, paths, and target markers show local plans. Displayed draft positions are separate from the chain snapshot: movement and range validation still use round-start positions, and previews never change HP, Energy, or Victory Points. Uncommitted drafts remain in memory. Commit saves the complete squad and Salt in IndexedDB before broadcasting. Saved orders are isolated by deployment session, chain, Arena, room, round, and account; refreshing or returning to the selected account restores them. Phase changes preserve the original orders for Reveal, while a new round starts with Hold drafts. A failed Commit retains the saved orders and Salt for retry. Pre-Reveal orders and Salt stay out of application APIs, logs, and telemetry.

## Browser round controls

Unit Confirm saves one local order. **Confirm orders** submits the entire three-unit squad. A compact modal explains that the orders will be locked for this round, with **Confirm**, **Keep editing**, and **Don't show this again**. Closing the modal, pressing Escape, or clicking its backdrop returns to editing. The preference is stored per local account in this browser. It skips future reminders; each round still requires its own Confirm orders click.

Confirmation generates a random 32-byte Salt, computes the standard-ABI commitment matching Solidity, and waits for durable IndexedDB transaction completion before sending it. The page waits for both confirmations, reveals each account's original saved orders automatically, and settles after both Reveals are accepted. The account that revealed last sends the settlement, so the two different accounts do not both request it. The contract updates the board, HP, Energy, Victory Points, round, and result. Room starts remain host-controlled. A new round waits for another explicit squad confirmation.

Keep the participating pages open while a round is processed. Refresh or returning to the account restores its saved secret and resumes the confirmed round. Unsent saved orders use Retry confirmation; failed automatic requests pause and expose Retry. Processing uses on-chain flags and phase state before sending another transaction. Closing a page pauses its participation until it is reopened.

Use **Orders backup** to export the saved round as a password-encrypted file. Encryption uses browser Web Crypto with PBKDF2-SHA256 and AES-GCM. Keep the file and password until the round is complete. Import checks deployment, chain, Arena, room, round, account, rules, canonical orders, and the on-chain commitment when one exists. Another browser connected to the same local deployment can restore the original orders. IndexedDB survives refresh but is not an encrypted vault; clearing site data removes local orders. If the original orders and backup are both lost, the Salt cannot be reconstructed.

The [Vite configuration](client/vite.config.js) sends a Content Security Policy header in development and local preview. Scripts load only from the application origin; inline scripts and string evaluation are blocked. Connections allow the application origin and local RPC, with the development WebSocket allowed only during development. Inline styles support Vue bindings and Vite style updates, and data images support Phaser's built-in textures. Encrypted backup downloads remain available. Embedding remains available for the editor's browser. These headers apply to Vite's servers; a separate production host must supply the same policy itself.

The page shows the chain's UTC phase deadline and a countdown using local time. Anvil retains transaction-triggered mining. When time has elapsed, **Finalize timeout** appears. On that click, the browser refreshes the phase; if the latest block time is still within the deadline, it updates the next local block to the current time and mines one block. It then reads the confirmed state and sends timeout finalization only when the chain timestamp is strictly beyond the same phase deadline. The contract decides the forfeit or draw. This occurs only through the timeout button; ordinary refresh does not mine blocks. Submissions at the exact deadline remain valid.

For newly observed RoundResolved events, the renderer reads battle states immediately before and at the event block. Confirmed surviving movements follow their revealed paths; HP loss, defeated-piece removal, Energy and point changes, and results use confirmed state. Pink drafts stay separate from these results. A defeated unit's final cell is erased by the contract, so its removal does not invent a movement result. Timeout shows the terminal result with the existing board. Reduced-motion preferences show the confirmed result directly. Refresh loads the current state without replaying past rounds.

## Local use

The current tool baseline is Node 22.23.2, npm 10.9.8, Go 1.25.3, Foundry 1.8.1, and Solidity 0.8.30. Install these tools before using the startup scripts. Keep the previously downloaded Solidity compiler in its existing local tools directory; the backend launcher uses it offline. The online backend also requires a running PostgreSQL service and an existing database. Offline vector and simulation modes require no database connection.

Reuse the existing PostgreSQL service on localhost port 5432. On this machine, the independently installed PostgreSQL 16 tools are available at the path below. Create the project database once using an existing database account; the example uses `postgres`. Enter that account's existing database password when prompted.

```
/Library/PostgreSQL/16/bin/createdb -h localhost -p 5432 -U postgres -W onchain_arena
```

The tracked [environment template](.env.example) lists `DATABASE_URL`, `PGPASSWORD`, `HTTP_ADDRESS`, and `CONFIRMATION_DEPTH`. Copy it into the launcher's local environment configuration, set the existing database password there, and adjust the username in `DATABASE_URL` if needed. Keep the real password out of the tracked template. PostgreSQL credentials are independent of the macOS account. The backend reuses this service and applies its SQL schema automatically. Normal startup needs only the backend and frontend scripts.

Run one script in each of two terminals at the project root. Start the backend first and wait for its ready message, then start the frontend. The frontend entry first checks that contract sources, compiler output, and backend launch scripts predate the current deployment. It stops with a backend restart instruction when they do not match. It then installs project dependencies, updates the npm lockfile, synchronizes the ABI, and starts Vite. The two entries handle their preparation steps automatically.

Backend:

```
./scripts/run-backend.sh
```

The backend launcher builds the Go service with cached dependencies, downloads missing build dependencies when necessary, builds Arena, exports the frontend ABI, starts a fresh Anvil chain, deploys Arena, publishes connection information, applies the database schema, and starts the Indexer and read API. It prints `Local Arena is ready` only after initial indexing and HTTP binding succeed. It sends no room creation, joining, start, Commit, Reveal, settlement, or timeout transactions. The first room is created when a player clicks Create room. These preparation steps remain inside this single entry point. Download failures remain visible and stop startup; successfully cached dependencies are reused on retry.

Frontend:

```
./scripts/run-frontend.sh
```

Open the address printed by Vite, normally http://127.0.0.1:5173. Select Account 1 and create a room. Open another tab, select Account 2, paste the room ID or copied invitation into Find a room, and join from the room page. Joining leaves both tabs in the waiting room; the host account alone sees Start game. Start from Account 1 and wait for confirmation: both room pages should automatically open the battlefield in Commit. Click a unit to open its narrow drawer on the unit's spawn side with a dark backdrop. Choose Move or Attack to return to the unobscured board, select a highlighted tile, then confirm or cancel the proposed order. The other account's drafts remain isolated. For each round, finish the three local orders and click Confirm orders in both tabs. Accept the reminder or return to editing. Keep both pages open as they automatically process the confirmed round. Export an encrypted backup if needed. Refresh after confirmation to recover the same saved orders and continue. Continue until the contract displays a result. After a phase deadline, Finalize timeout handles the contract's timeout result. Combining Shield and Power shot exceeds the initial Energy budget and prevents the unaffordable proposal from replacing its previous draft. Switching accounts returns that tab to a clean lobby; reopen the invitation to view or join its room with the newly selected account. Browser interactions, compilation, and type checking remain to be verified by the maintainer when running the project.

Keep ports 8545 and 8080 available. Each normal backend launch starts a fresh in-memory chain at http://127.0.0.1:8545 with chain ID 31337 and two local development accounts. The launcher prints the Arena address and deployment block. The newly deployed Arena starts with zero rooms; its first browser-created room receives ID 1. Old rooms disappear from the chain after a normal backend restart. PostgreSQL retains previous deployment records, isolated by chain ID, Arena address, and deployment block hash. Queries use only the currently running deployment.

Standard output and error output, including compilation and startup failures, appear in the terminal and are also written to a local log in the project root. Once Anvil starts listening, the launcher disables its routine RPC logging so idle Indexer polling does not flood the terminal or root log. Startup messages, indexing progress, and command/service errors keep their existing output paths. Each invocation overwrites the previous log, which is excluded from the repository. Live services continue appending after a maintenance invocation clears that log. Any failed startup step shuts down the launcher's Anvil process. The launcher keeps Go and the local chain running until Ctrl+C. Stopping it discards local chain state; PostgreSQL remains running under its own service manager.

## Event indexing and read API

The [Indexer](server/internal/indexer/chain.go) uses go-ethereum block-range log queries and batched header reads, ordered by block height and log index. It preserves raw logs, decoded payloads, block/parent hashes, transaction hashes, and log positions. One PostgreSQL transaction saves each range's headers, events, projections, and cursor. Duplicate logs skip projection. The [schema](server/internal/indexer/schema.sql) creates deployment, block, event, match, round, public action, snapshot, cursor, and Keeper-attempt tables. Keeper execution is not enabled.

The [Projector](server/internal/indexer/project.go) follows public events and uses the Go rules to build round snapshots. Pre-Reveal orders and salts never enter the database. Projected snapshots are explicitly unverified; storing the event's state hash does not certify that snapshot. Independent Replay verification follows separately.

The [read API](server/internal/indexer/http.go) defaults to http://127.0.0.1:8080:

| GET endpoint                          | Result                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `/health`                             | HTTP service and database availability                                                                    |
| `/ready`                              | Initial indexing complete, no known sync error, and no observed lag                                       |
| `/sync`                               | Active deployment, observed tip, indexed cursor/hash, confirmation policy, sync errors, and record counts |
| `/matches?limit=20&offset=0`          | Match page, ordered by numeric match ID                                                                   |
| `/matches/1`                          | Match detail, projected battle state, and source block/transaction/log                                    |
| `/matches/1/events?limit=20&offset=0` | Raw and decoded public events, ordered by block/log position                                              |

Pagination accepts limits from 1 to 100 and nonnegative offsets; `hasMore` indicates another page. Data and cursor metadata are read from one consistent database transaction. A zero confirmation depth labels local observations `observed`. A positive depth labels observations `provisional` until enough descendant blocks exist, then `confirmed`. These labels do not claim network finality or independent Replay verification. No extra blocks are mined to satisfy confirmation depth. A known RPC/indexing error makes confirmation status `unknown` and readiness fail while existing records remain readable. A changed cursor hash or broken parent link stops indexing explicitly; automatic branch recovery follows separately. The browser continues using RPC directly.

Keep the original backend terminal running. In another terminal at the project root, the same backend entry supports these operations:

```
./scripts/run-backend.sh status
```

```
./scripts/run-backend.sh restart
```

```
./scripts/run-backend.sh rescan
```

```
./scripts/run-backend.sh reindex
```

`restart` restarts only Go and resumes from the stored cursor, keeping Anvil and current rooms alive. `rescan` rereads the indexed range and compares all records before/after to detect duplicates or projection changes. `reindex` removes only the current deployment's rebuildable indexing data, reconstructs it from its deployment block, and compares every record against the previous incremental result at the same height. It preserves other deployments. Comparison excludes generated database row IDs, retains original block/transaction/log identities, and saves a local before/after report. Successful maintenance prints a comparison result followed by a new ready message in the original backend terminal. Maintenance commands request the operation and return; wait for that terminal's result before sending another operation. A comparison failure stops the backend and preserves its report.

For command-line acceptance, run this single command in one terminal at the project root:

```
./scripts/run-backend.sh test
```

The [backend entry](scripts/run-backend.sh) loads the environment, sets up logging, and builds Go. With no managed backend running, it starts Anvil, builds and deploys Arena, starts Go, waits for readiness, and runs the checks in the same terminal. It shuts down the Go and Anvil processes it started on completion, failure, or interruption. PostgreSQL uses the existing configured service. When a managed backend is already running, the command reuses it and leaves it running afterward. A separate backend terminal or frontend is not required.

The main script dispatches tests through `run_backend_tests`, currently calling the internal [Indexer check module](scripts/check-indexer.sh). Add later acceptance modules to that function. Checks run under the launcher's supervision so Go restart requests can be handled while testing continues. The Indexer check reloads Go, creates two new rooms, reads their actual IDs from creation receipts, and uses the unlocked local accounts to create, join, start, Commit, Reveal, and settle them through the real contract. The [shared action plans](server/internal/scenario/plans.go) produce a seven-round points win and a ten-round elimination win. Transactions proceed as soon as their receipts arrive, with no frontend interaction, deadline waits, interval mining, or manual time changes. Ordinary backend startup continues waiting for browser actions.

The [acceptance tool](server/internal/indexer/check.go) waits for indexing to catch up and compares the two chain results with API details, paginated events, stored raw logs, rounds, public reveals, and every projected snapshot. It then requests Go restart, rescan, and rebuild in sequence. Each operation must produce a different Go process and a ready API before the next comparison begins. The entire current deployment's records and cursor must remain identical, including pre-existing rooms. Rescan and rebuild must also produce fresh successful comparison reports. Process identity is included in API synchronization metadata.

When reusing a running backend, keep manual matches idle so the before/after comparisons cover the same chain tip. Progress and failures appear in the terminal and the same overwritten root log. Public receipts, match IDs, snapshots, and operation results are saved in a local acceptance report, including available evidence when a step fails. Salts and orders enter that evidence only after they are public on chain. The check adds two test matches. Existing rooms remain available when reusing a backend; a chain started by test mode is discarded when that command ends. Database records and local reports are retained. This check validates indexing against chain observations; independent historical Replay verification follows separately. The maintainer runs it explicitly.

The frontend manifest pins direct dependencies; its startup script maintains the npm lockfile during installation. CI and the project LICENSE are deferred by the maintainer.

## Current limits

The contracts implement complete matches through Commit/Reveal, settlement, and timeout handling. The browser supports local account selection, room creation/joining, host-controlled starts and automatic battlefield entry, live room and battle details through RPC, a Phaser board, local action planning, persistent browser Commit/Reveal, encrypted order backups, a single squad confirmation followed by automatic Reveal and settlement, manual timeout handling, and confirmed result animations. The Go rule engine, fixed-vector comparison, seeded offline simulation, PostgreSQL Indexer, and read API are implemented. External wallet signing, automatic reorg recovery, independently verified historical Go replay, frontend history integration, Keeper services, and public testnet deployment remain planned. The daily launcher prepares the local chain for manual browser interaction. Independent security auditing and game-balance evaluation remain separate work.

Detailed design and implementation planning are maintained locally.
