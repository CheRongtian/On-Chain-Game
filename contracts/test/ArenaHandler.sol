// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { Arena } from "../src/Arena.sol";
import { GameTypes } from "../src/GameTypes.sol";
import { GameHash } from "../src/GameHash.sol";
import { BattleResolver } from "../src/BattleResolver.sol";
import { SafetySupport, SafetyActions } from "./SafetySupport.sol";

// Operation codes and bit positions define the reproducible test input, not gameplay constants.
// forge-lint: disable-next-item(literal-instead-of-constant)
contract ArenaHandler is SafetySupport {
    struct Plan {
        GameTypes.Action[3][2] orders;
        bytes32[2] salts;
    }
    mapping(uint256 => Plan) private plans;
    mapping(uint256 => mapping(uint8 => bool)) private settled;
    uint256 public rooms;
    uint256 public successfulSettlements;

    constructor(Arena target) {
        arena = target;
        _create();
    }

    // A single targeted selector gives Foundry a shrinkable sequence of protocol operations.
    // forge-lint: disable-next-item(cyclomatic-complexity)
    function step(uint256 seed) external {
        uint256 operation = seed % 12;
        if (operation == 0 && rooms < 8) {
            _create();
            return;
        }
        uint256 id = (seed >> 8) % rooms + 1;
        GameTypes.MatchSummary memory summary = arena.getMatch(id);
        address caller = (seed >> 16) % 3 == 0 ? HOST : ((seed >> 16) % 3 == 1 ? GUEST : OBSERVER);
        uint8 round = summary.round;
        if ((seed >> 24) % 4 == 0 && round > 0) --round;
        if (operation == 9) {
            VM.warp(VM.getBlockTimestamp() + (seed >> 32) % (GameTypes.ROOM_LIFETIME + 2));
        } else if (operation == 10) {
            _progress(id, summary, seed);
        } else if (operation == 1) {
            _call(id, caller, abi.encodeCall(Arena.joinMatch, (id)));
        } else if (operation == 2) {
            _call(id, caller, abi.encodeCall(Arena.startMatch, (id)));
        } else if (operation == 3 || operation == 0) {
            _commit(id, caller, round, seed);
        } else if (operation == 4 || operation == 11) {
            uint256 player = caller == HOST ? 0 : 1;
            bytes32 salt = plans[id].salts[player];
            if (operation == 11) salt ^= bytes32(uint256(1));
            _call(
                id,
                caller,
                abi.encodeCall(Arena.revealActions, (id, round, plans[id].orders[player], salt))
            );
        } else if (operation == 5) {
            _settle(id, caller, round);
        } else if (operation == 6) {
            GameTypes.Phase phase =
                (seed >> 32) % 2 == 0 ? GameTypes.Phase.Commit : GameTypes.Phase.Reveal;
            _call(id, caller, abi.encodeCall(Arena.advanceExpiredPhase, (id, round, phase)));
        } else if (operation == 7) {
            _call(id, caller, abi.encodeCall(Arena.cancelWaitingMatch, (id)));
        } else {
            _call(id, caller, abi.encodeCall(Arena.expireWaitingMatch, (id)));
        }
    }

    // Every bounded room must be read and asserted against the fixed local Arena.
    // forge-lint: disable-next-item(calls-loop, require-revert-in-loop)
    function check() external view {
        for (uint256 id = 1; id <= rooms; ++id) {
            GameTypes.MatchSummary memory summary = arena.getMatch(id);
            if (summary.round == 0) continue;
            GameTypes.BattleState memory state = arena.getBattleState(id);
            SafetyActions.checkState(state);
            require(
                (summary.phase == GameTypes.Phase.Finished)
                    == (state.outcome != GameTypes.Outcome.None),
                "Terminal phase differs"
            );
            require(
                summary.stateHash == GameHash.hashBattleState(context(id), state),
                "Stored hash differs"
            );
            require(
                summary.round == state.round && summary.outcome == state.outcome
                    && summary.reason == state.reason,
                "Summary differs"
            );
            GameTypes.RoundStatus memory status = arena.getRoundStatus(id);
            require(!status.revealed[0] || status.committed[0], "Reveal without commitment");
            require(!status.revealed[1] || status.committed[1], "Reveal without commitment");
            if (summary.phase == GameTypes.Phase.Commit) {
                require(!status.revealed[0] && !status.revealed[1], "Old reveals survived");
            }
            if (summary.phase == GameTypes.Phase.Reveal) {
                require(status.committed[0] && status.committed[1], "Reveal opened early");
            }
            if (summary.phase == GameTypes.Phase.Resolvable) {
                require(status.revealed[0] && status.revealed[1], "Settlement opened early");
            }
            if (summary.phase == GameTypes.Phase.Finished) {
                require(
                    state.outcome != GameTypes.Outcome.None && summary.phaseDeadline == 0,
                    "Incomplete finish"
                );
            }
        }
    }

    function _create() private {
        uint256 expectedId = ++rooms;
        VM.prank(HOST);
        uint256 id = arena.createMatch(1);
        require(id == expectedId, "Unexpected room identity");
    }

    function _commit(uint256 id, address caller, uint8 round, uint256 seed) private {
        GameTypes.Action[3] memory orders = SafetyActions.holds();
        GameTypes.MatchSummary memory summary = arena.getMatch(id);
        uint256 player = caller == HOST ? 0 : 1;
        if (summary.phase == GameTypes.Phase.Commit) {
            orders = SafetyActions.generate(arena.getBattleState(id), caller == HOST ? 0 : 1, seed);
        }
        bytes32 salt = bytes32(seed);
        bytes32 value = bytes32(0);
        if (round > 0) value = GameHash.actionCommitment(context(id), round, caller, orders, salt);
        if (_call(id, caller, abi.encodeCall(Arena.commitActions, (id, round, value)))) {
            _storePlan(id, player, orders, salt);
        }
    }

    function _storePlan(uint256 id, uint256 player, GameTypes.Action[3] memory orders, bytes32 salt)
        private
    {
        // Explicit field copies work with the existing Solidity compilation pipeline.
        GameTypes.Action[3] storage saved = plans[id].orders[player];
        for (uint256 slot = 0; slot < GameTypes.SQUAD_SIZE; ++slot) {
            saved[slot].kind = orders[slot].kind;
            saved[slot].targetCell = orders[slot].targetCell;
            saved[slot].pathLength = orders[slot].pathLength;
            for (uint256 pathIndex = 0; pathIndex < GameTypes.MAX_PATH_LENGTH; ++pathIndex) {
                saved[slot].path[pathIndex] = orders[slot].path[pathIndex];
            }
        }
        plans[id].salts[player] = salt;
    }

    // Each protocol phase has distinct preconditions that the stateful driver must follow.
    // forge-lint: disable-next-item(cyclomatic-complexity)
    function _progress(uint256 id, GameTypes.MatchSummary memory summary, uint256 seed) private {
        if (summary.phase == GameTypes.Phase.Lobby) {
            if (VM.getBlockTimestamp() > summary.joinDeadline) return;
            if (summary.players[1] == address(0)) {
                _call(id, GUEST, abi.encodeCall(Arena.joinMatch, (id)));
            }
            _call(id, HOST, abi.encodeCall(Arena.startMatch, (id)));
        } else if (summary.phase == GameTypes.Phase.Commit) {
            if (VM.getBlockTimestamp() > summary.phaseDeadline) return;
            GameTypes.RoundStatus memory status = arena.getRoundStatus(id);
            if (!status.committed[0]) _commit(id, HOST, summary.round, seed);
            if (!status.committed[1]) _commit(id, summary.players[1], summary.round, seed / 7);
        } else if (summary.phase == GameTypes.Phase.Reveal) {
            if (VM.getBlockTimestamp() > summary.phaseDeadline) return;
            GameTypes.RoundStatus memory status = arena.getRoundStatus(id);
            for (uint256 player = 0; player < 2; ++player) {
                if (!status.revealed[player]) {
                    _call(
                        id,
                        summary.players[player],
                        abi.encodeCall(
                            Arena.revealActions,
                            (id, summary.round, plans[id].orders[player], plans[id].salts[player])
                        )
                    );
                }
            }
        } else if (summary.phase == GameTypes.Phase.Resolvable) {
            _settle(id, OBSERVER, summary.round);
        }
    }

    function _settle(uint256 id, address caller, uint8 round) private {
        GameTypes.MatchSummary memory beforeSummary = arena.getMatch(id);
        GameTypes.BattleState memory expected;
        if (beforeSummary.phase == GameTypes.Phase.Resolvable) {
            (expected,) = BattleResolver.resolve(
                arena.getBattleState(id), plans[id].orders[0], plans[id].orders[1]
            );
        }
        if (_call(id, caller, abi.encodeCall(Arena.settleRound, (id, round)))) {
            require(!settled[id][round], "Round settled twice");
            settled[id][round] = true;
            ++successfulSettlements;
            require(
                keccak256(abi.encode(expected)) == keccak256(abi.encode(arena.getBattleState(id))),
                "Settlement differs from resolver"
            );
        }
    }

    // Bounded reveal loops require raw calls and atomicity assertions for each local operation.
    // forge-lint: disable-next-item(calls-loop, require-revert-in-loop)
    function _call(uint256 id, address caller, bytes memory payload) private returns (bool ok) {
        bytes memory beforeState = snapshot(id);
        GameTypes.Phase phase = arena.getMatch(id).phase;
        // VM and Arena cannot call this handler back; plans are recorded only after acceptance.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        VM.prank(caller);
        bytes memory reason;
        // The fixed Arena has no callbacks; checked raw calldata exercises negative cases.
        // forge-lint: disable-next-line(reentrancy-no-eth, low-level-calls)
        (ok, reason) = address(arena).call(payload);
        if (!ok) {
            // At least four bytes are required before extracting the custom-error selector.
            // forge-lint: disable-next-line(unsafe-typecast)
            require(reason.length >= 4 && bytes4(reason) != bytes4(0x4e487b71), "Protocol panicked");
            require(keccak256(beforeState) == keccak256(snapshot(id)), "Revert changed storage");
        }
        if (
            phase == GameTypes.Phase.Finished || phase == GameTypes.Phase.Cancelled
                || phase == GameTypes.Phase.Expired
        ) {
            require(
                !ok && keccak256(beforeState) == keccak256(snapshot(id)), "Terminal match changed"
            );
        }
    }
}
