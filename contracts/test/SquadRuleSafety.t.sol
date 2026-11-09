// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "../src/SquadCodec.sol";
import { SquadParameters as Parameters } from "../src/SquadParameters.sol";
import { SquadRules } from "../src/SquadRules.sol";
import { SquadBattleResolver } from "../src/SquadBattleResolver.sol";
import { SquadBattleProbe } from "../script/CheckSquadBattle.s.sol";
import { IDevVm } from "../script/IDevVm.sol";
import { SquadSafetySupport as Support } from "./SquadSafetySupport.sol";

// The schema and assertions describe bounded, reproducible rule fixtures.
// forge-lint: disable-start(literal-instead-of-constant,require-revert-in-loop,calls-loop)
contract SquadRuleSafetyTest {
    IDevVm private constant VM = IDevVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    SquadBattleProbe private probe;

    struct Vector {
        string name;
        bool valid;
        SquadCodec.Context context;
        SquadCodec.State initial;
        SquadCodec.Action[3][2] actions;
        SquadCodec.State expected;
        SquadCodec.Effects effects;
        SquadBattleResolver.Checkpoints trace;
        bool hasTrace;
        bytes32 beforeHash;
        bytes32 stateHash;
    }

    function setUp() public {
        probe = new SquadBattleProbe();
    }

    function testAllOrderedLineupsAndMaps() public pure {
        for (uint8 mapId = 1; mapId <= Parameters.MAP_COUNT; ++mapId) {
            bool[216] memory seen;
            for (uint256 index = 0; index < 60; ++index) {
                uint8[3] memory types_ = Support.lineup(index);
                uint256 key = uint256(types_[0]) * 36 + uint256(types_[1]) * 6 + types_[2];
                require(!seen[key], "Ordered lineup repeated");
                seen[key] = true;
                SquadCodec.State memory state =
                    SquadRules.initialize(mapId, types_, Support.lineup((index * 17) % 60));
                Support.checkState(state);
                for (uint256 slot = 0; slot < 3; ++slot) {
                    require(
                        state.units[slot].unitType == types_[slot], "Birth slot lost profession"
                    );
                    require(
                        state.units[slot].position == Parameters.spawnsA()[slot]
                            && state.units[slot + 3].position == Parameters.spawnsB()[slot],
                        "Birth slot moved"
                    );
                }
            }
        }
    }

    function testFrozenRuleVectors() public view {
        // The backend test dispatcher prepares this ABI corpus from unchanged committed references.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        Vector[] memory vectors = abi.decode(
            VM.readFileBinary("../.local/simulation/squad-safety/references.abi"), (Vector[])
        );
        require(vectors.length == 103, "Incomplete frozen rule corpus");
        for (uint256 index = 0; index < vectors.length; ++index) {
            Vector memory vector = vectors[index];
            if (!vector.valid) {
                Support.reject(probe, vector.initial, vector.actions);
                continue;
            }
            SquadBattleProbe.Output memory actual =
                Support.run(probe, vector.context, vector.initial, vector.actions);
            require(
                Support.sameState(actual.next, vector.expected),
                string.concat(vector.name, ": state")
            );
            require(
                Support.sameEffects(actual.effects, vector.effects),
                string.concat(vector.name, ": effects")
            );
            require(
                actual.beforeHash == vector.beforeHash && actual.stateHash == vector.stateHash,
                string.concat(vector.name, ": hash")
            );
            if (vector.hasTrace) {
                for (uint256 id = 0; id < 6; ++id) {
                    require(
                        actual.trace.positions[id] == vector.trace.positions[id]
                            && actual.trace.supportHp[id] == vector.trace.supportHp[id]
                            && actual.trace.shields[id] == vector.trace.shields[id]
                            && actual.trace.rawDamage[id] == vector.trace.rawDamage[id]
                            && actual.trace.damageHp[id] == vector.trace.damageHp[id],
                        string.concat(vector.name, ": checkpoint")
                    );
                }
                require(
                    actual.trace.activeRound == vector.trace.activeRound,
                    string.concat(vector.name, ": active round")
                );
            }
        }
    }

    function testFuzzLegalSnapshots(uint256 seed) public view {
        SquadCodec.State memory state = Support.sample(seed);
        SquadCodec.Action[3][2] memory actions = Support.generate(state, seed);
        SquadBattleProbe.Output memory first = Support.run(probe, Support.context(), state, actions);
        SquadBattleProbe.Output memory swapped = Support.run(
            probe, Support.context(), Support.swapState(state), Support.swapActions(actions)
        );
        require(
            Support.sameState(swapped.next, Support.swapState(first.next)),
            "Ownership changed resolution"
        );
        require(
            Support.sameEffects(swapped.effects, Support.swapEffects(first.effects)),
            "Ownership changed effects"
        );
    }

    // Each branch selects one shrinkable malformed-state family.
    // forge-lint: disable-next-item(cyclomatic-complexity)
    function testFuzzInvalidStates(uint256 seed, uint8 selected) public view {
        SquadCodec.State memory state = Support.sample(seed);
        uint256 choice = selected % 12;
        if (choice == 0) {
            state.units[0].hp = Parameters.unitRule(state.units[0].unitType)[0] + 1;
        } else if (choice == 1) {
            state.units[0].position = 255;
        } else if (choice == 2) {
            state.units[0].position = state.units[1].position;
        } else if (choice == 3) {
            state.energy[0] = 6;
        } else if (choice == 4) {
            state.units[0].lockedRound = state.completedRound + 2;
        } else if (choice == 5) {
            state.units[0].alive = false;
        } else if (choice == 6) {
            state.battleStarted = false;
        } else if (choice == 7) {
            state.completedRound = 20;
        } else if (choice == 8) {
            state.outcome = 1;
            state.reason = 5;
        } else if (choice == 9) {
            state.units[0].unitType = 0;
        } else if (choice == 10) {
            state.mapId = 0;
        } else {
            state.units[0].hp = 0;
            state.units[0].alive = false;
        }
        Support.reject(probe, state, Support.holds());
    }

    function testFuzzInvalidActions(uint256 seed, uint8 selected) public view {
        SquadCodec.State memory state = Support.sample(seed);
        SquadCodec.Action[3][2] memory actions = Support.holds();
        uint256 choice = selected % 9;
        if (choice == 0) {
            actions[0][0].targetCell = 0;
        } else if (choice == 1) {
            actions[0][0].targetUnit = 0;
        } else if (choice == 2) {
            actions[0][0].pathBits = 1;
        } else if (choice == 3) {
            actions[0][0].actionType = 4;
        } else if (choice < 7) {
            actions[0][0].actionType = 1;
            actions[0][0].pathLength = choice == 6 ? 5 : 1;
            actions[0][0].pathBits = choice == 4 ? state.units[0].position : 64;
        } else if (choice == 7) {
            state.units[0].hp = 0;
            state.units[0].alive = false;
            state.units[0].position = 255;
            state.units[0].lockedRound = 0;
            actions[0][0].actionType = 2;
            actions[0][0].targetCell = 0;
        } else {
            state.units[0].lockedRound = state.completedRound + 1;
            actions[0][0].actionType = 3;
        }
        Support.reject(probe, state, actions);
    }

    function testWholeBundleBudgetRejectsSixCost() public view {
        SquadCodec.State memory state = SquadRules.initialize(1, [uint8(2), 4, 5], [uint8(1), 2, 3]);
        state.completedRound = 3;
        state.energy[0] = 5;
        uint8[6] memory cells = [uint8(0), 2, 4, 56, 58, 60];
        for (uint256 id = 0; id < 6; ++id) {
            state.units[id].position = cells[id];
        }
        SquadCodec.Action[3][2] memory actions = Support.holds();
        for (uint256 slot = 0; slot < 3; ++slot) {
            actions[0][slot].actionType = 3;
        }
        actions[0][0].targetCell = 1;
        actions[0][1].targetUnit = 0;
        actions[0][2].targetCell = 3;
        Support.reject(probe, state, actions);
    }

    function testFuzzCompleteGames(uint256 seed) public view {
        // The modulo selects exactly one frozen map.
        // forge-lint: disable-next-line(unsafe-typecast)
        _game(uint8(1 + seed % 3), seed);
    }

    function testDiagnosticFrameIncludesInputAndOutput() public {
        SquadCodec.State memory state = Support.initialized(1, 0);
        SquadBattleProbe.Output memory output =
            Support.run(probe, Support.context(), state, Support.holds());
        --output.trace.damageHp[0];
        try this.verifyTransition(output) {
            revert("Altered damage checkpoint accepted");
        } catch (bytes memory reason) {
            require(reason.length > 4, "Missing failure frame");
            // The length guard leaves a complete four-byte selector before the encoded frame.
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes4 selector = bytes4(reason);
            require(selector == Support.RuleSafetyFailure.selector, "Wrong failure frame");
            // This generated negative-control witness stays in the simulation evidence directory.
            // forge-lint: disable-next-line(unsafe-cheatcode)
            VM.writeFile(
                "../.local/simulation/squad-safety/failure-witness.abi", VM.toString(reason)
            );
        }
    }

    function verifyTransition(SquadBattleProbe.Output memory output) external pure {
        Support.checkTransition(output.initial, output.actions, output);
    }

    function testExportGeneratedGames() public {
        uint256[4] memory seeds = [uint256(0), 42, 2026, 8675309];
        uint256 index = 0;
        for (uint8 mapId = 1; mapId <= Parameters.MAP_COUNT; ++mapId) {
            for (uint256 seedIndex = 0; seedIndex < seeds.length; ++seedIndex) {
                // Each game gets fresh EVM memory; the exported array contains accepted rounds only.
                this.exportGame(mapId, seeds[seedIndex], index);
                ++index;
            }
        }
    }

    function exportGame(uint8 mapId, uint256 seed, uint256 index) external {
        SquadBattleProbe.Output[] memory frames = _game(mapId, seed);
        // Only the existing simulation evidence directory is writable.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        VM.writeFile(
            string.concat("../.local/simulation/squad-safety/game-", VM.toString(index), ".abi"),
            VM.toString(abi.encode(seed, mapId, frames))
        );
    }

    function _game(uint8 mapId, uint256 seed)
        private
        view
        returns (SquadBattleProbe.Output[] memory frames)
    {
        SquadBattleProbe.Output[20] memory buffer;
        uint16 rounds = 0;
        SquadCodec.State memory state = Support.initialized(mapId, seed);
        for (; rounds < Parameters.MAX_ROUNDS && state.outcome == 0; ++rounds) {
            seed = Support.nextSeed(seed);
            SquadBattleProbe.Output memory output =
                Support.run(probe, Support.context(), state, Support.generate(state, seed));
            buffer[rounds] = output;
            state = output.next;
        }
        require(
            state.outcome != 0 && state.completedRound == rounds,
            "Game failed to terminate within cap"
        );
        Support.reject(probe, state, Support.holds());
        frames = new SquadBattleProbe.Output[](rounds);
        for (uint256 index = 0; index < rounds; ++index) {
            frames[index] = buffer[index];
        }
    }
}
// forge-lint: disable-end(literal-instead-of-constant,require-revert-in-loop,calls-loop)
