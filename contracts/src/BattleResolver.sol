// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "./GameTypes.sol";
import { UnitRules } from "./UnitRules.sol";
import { MapRules } from "./MapRules.sol";
import { ResultRules } from "./ResultRules.sol";
import { IArena } from "./IArena.sol";

library BattleResolver {
    uint256 private constant SQUAD_SIZE = 3;
    uint256 private constant UNIT_COUNT = 6;

    function resolve(
        GameTypes.BattleState memory initial,
        GameTypes.Action[SQUAD_SIZE] memory actionsA,
        GameTypes.Action[SQUAD_SIZE] memory actionsB
    )
        internal
        pure
        returns (GameTypes.BattleState memory next, GameTypes.ResolutionSummary memory summary)
    {
        // Batch fixtures also exercise the same terminal-state rejection as production callers.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (initial.outcome != GameTypes.Outcome.None) revert IArena.InvalidBattleResult();
        summary.energySpent[0] = UnitRules.validateActions(initial, 0, actionsA);
        summary.energySpent[1] = UnitRules.validateActions(initial, 1, actionsB);

        next = _copyAndCharge(initial, summary.energySpent);
        GameTypes.Action[UNIT_COUNT] memory actions = _allActions(actionsA, actionsB);
        _move(next, actions, summary);
        _combat(next, actions, summary);
        _awardResourcesAndControl(next, summary);
        (next.outcome, next.reason) = ResultRules.evaluate(next);
        if (next.outcome == GameTypes.Outcome.None) ++next.round;
    }

    function _copyAndCharge(GameTypes.BattleState memory initial, uint8[2] memory costs)
        private
        pure
        returns (GameTypes.BattleState memory next)
    {
        // Copy primitive fields so output updates cannot alias the input's nested structs.
        next.mapId = initial.mapId;
        next.round = initial.round;
        next.outcome = initial.outcome;
        next.reason = initial.reason;
        for (uint256 player = 0; player < initial.players.length; ++player) {
            next.players[player].energy = initial.players[player].energy - costs[player];
            next.players[player].victoryPoints = initial.players[player].victoryPoints;
        }
        for (uint256 slot = 0; slot < GameTypes.UNIT_COUNT; ++slot) {
            next.units[slot].unitType = initial.units[slot].unitType;
            next.units[slot].cell = initial.units[slot].cell;
            next.units[slot].hp = initial.units[slot].hp;
        }
    }

    function _allActions(
        GameTypes.Action[SQUAD_SIZE] memory actionsA,
        GameTypes.Action[SQUAD_SIZE] memory actionsB
    ) private pure returns (GameTypes.Action[UNIT_COUNT] memory actions) {
        for (uint256 slot = 0; slot < GameTypes.SQUAD_SIZE; ++slot) {
            actions[slot] = actionsA[slot];
            actions[slot + GameTypes.SQUAD_SIZE] = actionsB[slot];
        }
    }

    function _move(
        GameTypes.BattleState memory next,
        GameTypes.Action[UNIT_COUNT] memory actions,
        GameTypes.ResolutionSummary memory summary
    ) private pure {
        uint8[UNIT_COUNT] memory endpoints;
        bool[UNIT_COUNT] memory candidates;
        for (uint256 slot = 0; slot < GameTypes.UNIT_COUNT; ++slot) {
            endpoints[slot] = next.units[slot].cell;
            if (
                actions[slot].kind == GameTypes.ActionKind.Move
                    || actions[slot].kind == GameTypes.ActionKind.Dash
            ) {
                endpoints[slot] = actions[slot].path[actions[slot].pathLength - 1];
                candidates[slot] = true;
            }
        }
        for (uint256 slot = 0; slot < GameTypes.UNIT_COUNT; ++slot) {
            if (candidates[slot] && _uniqueEndpoint(slot, endpoints, candidates)) {
                next.units[slot].cell = endpoints[slot];
                summary.moved[slot] = true;
            }
        }
    }

    function _uniqueEndpoint(
        uint256 slot,
        uint8[UNIT_COUNT] memory endpoints,
        bool[UNIT_COUNT] memory candidates
    ) private pure returns (bool) {
        for (uint256 other = 0; other < GameTypes.UNIT_COUNT; ++other) {
            if (other != slot && candidates[other] && endpoints[slot] == endpoints[other]) {
                return false;
            }
        }
        return true;
    }

    function _combat(
        GameTypes.BattleState memory next,
        GameTypes.Action[UNIT_COUNT] memory actions,
        GameTypes.ResolutionSummary memory summary
    ) private pure {
        GameTypes.Rules memory rules = GameTypes.defaultRules();
        uint8[UNIT_COUNT] memory incoming;
        // HP remains at its round-start value until every attack has contributed damage.
        for (uint256 slot = 0; slot < GameTypes.UNIT_COUNT; ++slot) {
            uint8 damage = _attackDamage(next.units[slot].unitType, actions[slot].kind, rules);
            if (damage == 0) continue;
            uint256 target = _enemyAt(next.units, slot, actions[slot].targetCell);
            if (target != GameTypes.UNIT_COUNT) incoming[target] += damage;
        }
        _applyDamage(next, actions, incoming, rules.shieldReduction, summary);
    }

    function _attackDamage(
        GameTypes.UnitKind unitType,
        GameTypes.ActionKind kind,
        GameTypes.Rules memory rules
    ) private pure returns (uint8) {
        if (kind == GameTypes.ActionKind.PowerShot) {
            return rules.powerShotDamage;
        }
        if (kind == GameTypes.ActionKind.Attack) {
            return rules.attackDamage[uint256(unitType) - 1];
        }
        return 0;
    }

    function _enemyAt(GameTypes.UnitState[UNIT_COUNT] memory units, uint256 attacker, uint8 cell)
        private
        pure
        returns (uint256)
    {
        uint256 start = attacker < GameTypes.SQUAD_SIZE ? GameTypes.SQUAD_SIZE : 0;
        for (uint256 slot = start; slot < start + GameTypes.SQUAD_SIZE; ++slot) {
            if (units[slot].hp != 0 && units[slot].cell == cell) return slot;
        }
        return GameTypes.UNIT_COUNT;
    }

    function _applyDamage(
        GameTypes.BattleState memory next,
        GameTypes.Action[UNIT_COUNT] memory actions,
        uint8[UNIT_COUNT] memory incoming,
        uint8 shieldReduction,
        GameTypes.ResolutionSummary memory summary
    ) private pure {
        for (uint256 slot = 0; slot < GameTypes.UNIT_COUNT; ++slot) {
            uint8 damage = incoming[slot];
            if (actions[slot].kind == GameTypes.ActionKind.Shield) {
                damage = damage > shieldReduction ? damage - shieldReduction : 0;
            }
            uint8 hp = next.units[slot].hp;
            uint8 applied = damage > hp ? hp : damage;
            summary.damageTaken[slot] = applied;
            next.units[slot].hp = hp - applied;
            if (next.units[slot].hp == 0) next.units[slot].cell = GameTypes.NO_CELL;
        }
    }

    function _awardResourcesAndControl(
        GameTypes.BattleState memory next,
        GameTypes.ResolutionSummary memory summary
    ) private pure {
        GameTypes.MapConfig memory map = GameTypes.defaultMap();
        GameTypes.Rules memory rules = GameTypes.defaultRules();
        uint8[2] memory income;
        uint8[2] memory control;
        for (uint256 slot = 0; slot < GameTypes.UNIT_COUNT; ++slot) {
            if (next.units[slot].hp == 0) continue;
            uint256 player = slot / GameTypes.SQUAD_SIZE;
            uint8 cell = next.units[slot].cell;
            if (MapRules.contains(map.resources, cell)) income[player] += rules.resourceIncome;
            if (MapRules.contains(map.controlZone, cell)) ++control[player];
        }
        for (uint256 player = 0; player < next.players.length; ++player) {
            uint8 room = rules.maxEnergy - next.players[player].energy;
            uint8 credited = income[player] > room ? room : income[player];
            next.players[player].energy += credited;
            summary.energyGained[player] = credited;
        }
        if (control[0] > control[1]) {
            next.players[0].victoryPoints += rules.controlAward;
            summary.victoryPointsGained[0] = rules.controlAward;
        } else if (control[1] > control[0]) {
            next.players[1].victoryPoints += rules.controlAward;
            summary.victoryPointsGained[1] = rules.controlAward;
        }
    }
}
