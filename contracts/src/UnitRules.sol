// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "./GameTypes.sol";
import { GameHash } from "./GameHash.sol";
import { MapRules } from "./MapRules.sol";
import { IArena } from "./IArena.sol";

library UnitRules {
    enum ActionIssue {
        None,
        Action,
        Path,
        Target
    }

    // Validates one complete squad against the round-start snapshot, without mutation.
    // Batch battle fixtures intentionally retain every production rejection guard.
    function validateActions(
        GameTypes.BattleState memory state, uint8 playerIndex, GameTypes.Action[3] memory actions
    ) internal pure returns (uint8 requiredEnergy) {
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (playerIndex >= state.players.length) revert IArena.InvalidPlayerState(playerIndex);
        GameHash.validateBattleState(state);
        GameHash.validateActionEncoding(actions);

        uint64 blocked = _initialBlockedCells(state.units);
        uint8 unitId = playerIndex * GameTypes.SQUAD_SIZE;
        ActionIssue issue = ActionIssue.None;
        requiredEnergy = 0;
        for (uint8 slot = 0; slot < GameTypes.SQUAD_SIZE; ++slot) {
            uint8 cost = 0;
            (issue, cost) = _checkAction(state.units[unitId], actions[slot], blocked);
            if (issue != ActionIssue.None) break;
            requiredEnergy += cost;
            ++unitId;
        }
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (issue == ActionIssue.Action) revert IArena.InvalidAction(unitId);
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (issue == ActionIssue.Path) revert IArena.InvalidPath(unitId);
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (issue == ActionIssue.Target) revert IArena.InvalidTarget(unitId);
        uint8 available = state.players[playerIndex].energy;
        if (requiredEnergy > available) {
            // forge-lint: disable-next-line(require-revert-in-loop)
            revert IArena.InsufficientEnergy(playerIndex, requiredEnergy, available);
        }
    }

    function _initialBlockedCells(GameTypes.UnitState[6] memory units)
        private
        pure
        returns (uint64 blocked)
    {
        blocked = GameTypes.defaultMap().obstacles;
        uint8 slot = 0;
        for (; slot < GameTypes.UNIT_COUNT; ++slot) {
            if (units[slot].hp == 0) continue;
            if (MapRules.contains(blocked, units[slot].cell)) break;
            blocked |= uint64(1) << units[slot].cell;
        }
        // Reject malformed occupancy even when invoked by a batch fixture loop.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (slot < GameTypes.UNIT_COUNT) revert IArena.InvalidUnitState(slot);
    }

    function _checkAction(
        GameTypes.UnitState memory unit, GameTypes.Action memory action, uint64 blocked
    ) private pure returns (ActionIssue, uint8) {
        if (unit.hp == 0 && action.kind != GameTypes.ActionKind.Hold) {
            return (ActionIssue.Action, 0);
        }
        if (action.kind == GameTypes.ActionKind.Hold) return (ActionIssue.None, 0);

        if (action.kind == GameTypes.ActionKind.Move || action.kind == GameTypes.ActionKind.Dash) {
            return _checkMove(unit, action, blocked);
        }
        if (
            action.kind == GameTypes.ActionKind.Attack
                || action.kind == GameTypes.ActionKind.PowerShot
        ) {
            return _checkAttack(unit, action);
        }
        if (
            action.kind == GameTypes.ActionKind.Shield
                && unit.unitType == GameTypes.UnitKind.Guardian
        ) return (ActionIssue.None, GameTypes.defaultRules().skillCost[0]);
        return (ActionIssue.Action, 0);
    }

    function _checkMove(
        GameTypes.UnitState memory unit, GameTypes.Action memory action, uint64 blocked
    ) private pure returns (ActionIssue, uint8) {
        bool dash = action.kind == GameTypes.ActionKind.Dash;
        if (dash && unit.unitType != GameTypes.UnitKind.Scout) return (ActionIssue.Action, 0);

        GameTypes.Rules memory rules = GameTypes.defaultRules();
        uint256 typeIndex = uint256(unit.unitType) - 1;
        uint8 limit = dash ? rules.dashRange : rules.moveRange[typeIndex];
        bool valid = MapRules.isValidPath(
            unit.cell, action.pathLength, action.path, limit, blocked
        );
        return (
            valid ? ActionIssue.None : ActionIssue.Path,
            dash ? rules.skillCost[typeIndex] : uint8(0)
        );
    }

    function _checkAttack(GameTypes.UnitState memory unit, GameTypes.Action memory action)
        private
        pure
        returns (ActionIssue, uint8)
    {
        bool powerShot = action.kind == GameTypes.ActionKind.PowerShot;
        if (powerShot && unit.unitType != GameTypes.UnitKind.Ranger) {
            return (ActionIssue.Action, 0);
        }

        GameTypes.Rules memory rules = GameTypes.defaultRules();
        uint256 typeIndex = uint256(unit.unitType) - 1;
        bool valid = unit.unitType == GameTypes.UnitKind.Ranger
            ? MapRules.isClearRay(
                unit.cell, action.targetCell, rules.attackRange[typeIndex],
                GameTypes.defaultMap().obstacles
            )
            : MapRules.isAdjacent(unit.cell, action.targetCell);
        return (
            valid ? ActionIssue.None : ActionIssue.Target,
            powerShot ? rules.skillCost[typeIndex] : uint8(0)
        );
    }
}
