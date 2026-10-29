// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { Arena } from "../src/Arena.sol";
import { GameTypes } from "../src/GameTypes.sol";
import { GameHash } from "../src/GameHash.sol";
import { MapRules } from "../src/MapRules.sol";
import { UnitRules } from "../src/UnitRules.sol";
import { IDevVm } from "../script/IDevVm.sol";

// The VM interface and helpers are colocated solely for these offline fixtures.
// forge-lint: disable-next-line(multi-contract-file)
interface ISafetyVm is IDevVm {
    function pauseGasMetering() external;
    function resumeGasMetering() external;
}

// Literal cells and action indices keep the fixed board fixtures readable.
// forge-lint: disable-next-item(multi-contract-file, literal-instead-of-constant)
library SafetyActions {
    function holds() internal pure returns (GameTypes.Action[3] memory actions) {
        for (uint256 slot = 0; slot < 3; ++slot) {
            actions[slot].targetCell = GameTypes.NO_CELL;
        }
    }

    // The generator deliberately enumerates all action kinds and their legality branches.
    // forge-lint: disable-next-item(cyclomatic-complexity)
    function generate(GameTypes.BattleState memory state, uint8 player, uint256 seed)
        internal
        pure
        returns (GameTypes.Action[3] memory actions)
    {
        actions = holds();
        uint64 blocked = GameTypes.defaultMap().obstacles;
        for (uint256 slot = 0; slot < 6; ++slot) {
            if (state.units[slot].hp != 0) blocked |= uint64(1) << state.units[slot].cell;
        }
        uint8 remaining = state.players[player].energy;
        for (uint256 slot = 0; slot < 3; ++slot) {
            // Only a reproducible input generator; production combat has no randomness.
            unchecked {
                seed = seed * 1_664_525 + 1_013_904_223;
            }
            GameTypes.UnitState memory unit = state.units[uint256(player) * 3 + slot];
            if (unit.hp == 0) continue;
            GameTypes.Action memory action;
            action.targetCell = GameTypes.NO_CELL;
            action.kind = GameTypes.ActionKind((seed >> 16) % 6);
            uint8 cost = 0;
            if (action.kind == GameTypes.ActionKind.Shield) {
                if (unit.unitType != GameTypes.UnitKind.Guardian) continue;
                cost = 1;
            } else if (action.kind == GameTypes.ActionKind.PowerShot) {
                if (unit.unitType != GameTypes.UnitKind.Ranger) continue;
                cost = 2;
            } else if (action.kind == GameTypes.ActionKind.Dash) {
                if (unit.unitType != GameTypes.UnitKind.Scout) continue;
                cost = 1;
            }
            if (cost > remaining) continue;
            if (
                action.kind == GameTypes.ActionKind.Move || action.kind == GameTypes.ActionKind.Dash
            ) {
                action = _path(unit, action.kind, blocked, seed);
                if (action.pathLength == 0) continue;
            } else if (
                action.kind == GameTypes.ActionKind.Attack
                    || action.kind == GameTypes.ActionKind.PowerShot
            ) {
                for (uint256 offset = 0; offset < 64; ++offset) {
                    // The modulo bounds the generated target.
                    // forge-lint: disable-next-line(unsafe-typecast)
                    uint8 cell = uint8((seed / 6 + offset) % 64);
                    bool valid = unit.unitType == GameTypes.UnitKind.Ranger
                        ? MapRules.isClearRay(unit.cell, cell, 3, GameTypes.defaultMap().obstacles)
                        : MapRules.isAdjacent(unit.cell, cell);
                    if (valid) {
                        action.targetCell = cell;
                        break;
                    }
                }
                if (action.targetCell == GameTypes.NO_CELL) continue;
            }
            actions[slot] = action;
            remaining -= cost;
        }
        UnitRules.validateActions(state, player, actions);
    }

    function _path(
        GameTypes.UnitState memory unit,
        GameTypes.ActionKind kind,
        uint64 blocked,
        uint256 seed
    ) private pure returns (GameTypes.Action memory action) {
        action.kind = kind;
        action.targetCell = GameTypes.NO_CELL;
        uint8 limit = kind == GameTypes.ActionKind.Dash
            ? 4
            : GameTypes.defaultRules().moveRange[uint256(unit.unitType) - 1];
        // The generated length stays within the selected unit's limit.
        // forge-lint: disable-next-line(unsafe-typecast)
        limit = uint8(1 + (seed >> 24) % limit);
        uint64 visited = uint64(1) << unit.cell;
        uint8 previous = unit.cell;
        for (uint256 step = 0; step < limit; ++step) {
            uint8 cell = _next(previous, blocked | visited, seed >> (step * 2 + 8));
            if (cell == previous) break;
            action.path[action.pathLength++] = cell;
            visited |= uint64(1) << cell;
            previous = cell;
        }
    }

    function _next(uint8 previous, uint64 blocked, uint256 direction) private pure returns (uint8) {
        for (uint256 offset = 0; offset < 4; ++offset) {
            int256 candidate = int256(uint256(previous));
            uint256 selected = (direction + offset) % 4;
            if (selected == 0) candidate -= 8;
            else if (selected == 1) candidate += 1;
            else if (selected == 2) candidate += 8;
            else candidate -= 1;
            if (candidate < 0 || candidate >= 64) continue;
            // The candidate is bounded to a board cell above.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8 next = uint8(uint256(candidate));
            if (MapRules.isAdjacent(previous, next) && !MapRules.contains(blocked, next)) {
                return next;
            }
        }
        return previous;
    }

    // Every live slot and both resource records must be asserted in the bounded test loop.
    // forge-lint: disable-next-item(require-revert-in-loop)
    function checkState(GameTypes.BattleState memory state) internal pure {
        GameHash.validateBattleState(state);
        uint64 occupied = GameTypes.defaultMap().obstacles;
        for (uint256 slot = 0; slot < 6; ++slot) {
            GameTypes.UnitState memory unit = state.units[slot];
            if (unit.hp == 0) continue;
            require(!MapRules.contains(occupied, unit.cell), "Live unit overlap or obstacle");
            occupied |= uint64(1) << unit.cell;
        }
        for (uint256 player = 0; player < 2; ++player) {
            require(
                state.players[player].victoryPoints <= GameTypes.VICTORY_THRESHOLD,
                "Unreachable score"
            );
        }
    }
}

// Shared helpers remain beside the test-only VM interface and action generator.
// forge-lint: disable-next-line(multi-contract-file)
abstract contract SafetySupport {
    ISafetyVm internal constant VM = ISafetyVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address internal constant HOST = address(0xA11CE);
    address internal constant GUEST = address(0xB0B);
    address internal constant OBSERVER = address(0xCAFE);
    bytes32 internal constant SALT_A = bytes32(uint256(1));
    bytes32 internal constant SALT_B = bytes32(uint256(2));
    Arena internal arena;

    function context(uint256 id) internal view returns (GameTypes.MatchContext memory) {
        return
            GameTypes.MatchContext({ chainId: block.chainid, arena: address(arena), matchId: id });
    }

    // Repeated fixtures exercise the same locally deployed Arena and VM, with no callbacks.
    // forge-lint: disable-next-item(calls-loop)
    function room() internal returns (uint256 id) {
        VM.prank(HOST);
        id = arena.createMatch(1);
        VM.prank(GUEST);
        arena.joinMatch(id);
        VM.prank(HOST);
        arena.startMatch(id);
    }

    // Complete-game loops must submit each player's orders to the fixed local contract.
    // forge-lint: disable-next-item(calls-loop)
    function commit(uint256 id, address player, GameTypes.Action[3] memory orders, bytes32 salt)
        internal
    {
        uint8 round = arena.getMatch(id).round;
        bytes32 value = GameHash.actionCommitment(context(id), round, player, orders, salt);
        VM.prank(player);
        arena.commitActions(id, round, value);
    }

    // Complete-game loops must reveal each player's saved orders to the fixed local contract.
    // forge-lint: disable-next-item(calls-loop)
    function reveal(uint256 id, address player, GameTypes.Action[3] memory orders, bytes32 salt)
        internal
    {
        uint8 round = arena.getMatch(id).round;
        VM.prank(player);
        arena.revealActions(id, round, orders, salt);
    }

    // Local getters are deliberately reread after every attempted state-machine operation.
    // forge-lint: disable-next-item(calls-loop)
    function snapshot(uint256 id) internal view returns (bytes memory) {
        GameTypes.MatchSummary memory summary = arena.getMatch(id);
        if (summary.round == 0) return abi.encode(summary);
        return abi.encode(summary, arena.getBattleState(id), arena.getRoundStatus(id));
    }

    // Negative cases assert rejection and atomicity on every bounded protocol iteration.
    // forge-lint: disable-next-item(calls-loop, require-revert-in-loop)
    function rejected(uint256 id, address caller, bytes memory payload, bytes4 selector) internal {
        bytes memory beforeState = snapshot(id);
        VM.prank(caller);
        // Raw calldata is required to inspect the exact rejection without aborting the fixture.
        // forge-lint: disable-next-line(low-level-calls)
        (bool ok, bytes memory reason) = address(arena).call(payload);
        // The length guard permits extracting exactly the four-byte error selector.
        // forge-lint: disable-next-line(unsafe-typecast)
        require(!ok && reason.length >= 4 && bytes4(reason) == selector, "Unexpected rejection");
        require(keccak256(beforeState) == keccak256(snapshot(id)), "Rejected call changed state");
    }
}
