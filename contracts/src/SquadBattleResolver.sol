// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "./SquadCodec.sol";
import { SquadParameters as Parameters } from "./SquadParameters.sol";
import { SquadMapRules as Geometry } from "./SquadMapRules.sol";
import { SquadRules } from "./SquadRules.sol";
import { SquadUnitRules } from "./SquadUnitRules.sol";

// Numeric codes and rule-array indices retain their frozen protocol meanings.
// forge-lint: disable-start(literal-instead-of-constant)
library SquadBattleResolver {
    // Other checkpoints are already present in State and Effects, without copying whole boards.
    struct Checkpoints {
        uint8[6] positions;
        uint8[6] supportHp;
        uint8[6] shields;
        uint8[6] rawDamage;
        uint8[6] damageHp;
        uint16 activeRound;
    }

    function resolve(SquadCodec.State memory initial, SquadCodec.Action[3][2] memory bundles)
        internal
        pure
        returns (
            SquadCodec.State memory next,
            SquadCodec.Effects memory effects,
            Checkpoints memory trace
        )
    {
        effects.energySpent[0] = SquadUnitRules.validateActions(initial, 0, bundles[0]);
        effects.energySpent[1] = SquadUnitRules.validateActions(initial, 1, bundles[1]);
        next = _copyAndCharge(initial, effects.energySpent);
        SquadCodec.Action[6] memory actions;
        for (uint256 id = 0; id < Parameters.UNIT_COUNT; ++id) {
            actions[id] = bundles[id / Parameters.SQUAD_SIZE][id % Parameters.SQUAD_SIZE];
        }
        _movement(next, actions, effects, trace);
        _support(next, actions, effects, trace);
        _damage(next, actions, effects, trace);
        _status(next, actions, effects);
        _worldUpdate(next, effects);
        ++next.completedRound;
        (next.outcome, next.reason) = _result(next);
        trace.activeRound = next.outcome == 0 ? next.completedRound + 1 : next.completedRound;
    }

    function _copyAndCharge(SquadCodec.State memory initial, uint8[2] memory costs)
        private
        pure
        returns (SquadCodec.State memory next)
    {
        next.mapId = initial.mapId;
        next.battleStarted = initial.battleStarted;
        next.completedRound = initial.completedRound;
        for (uint256 side = 0; side < 2; ++side) {
            next.energy[side] = initial.energy[side] - costs[side];
            next.victoryPoints[side] = initial.victoryPoints[side];
        }
        // Explicit field copies prevent nested memory structs from aliasing the input.
        for (uint256 id = 0; id < Parameters.UNIT_COUNT; ++id) {
            SquadCodec.Unit memory unit = initial.units[id];
            next.units[id] = SquadCodec.Unit(
                unit.unitType, unit.position, unit.hp, unit.alive, unit.lockedRound
            );
        }
    }

    function _movement(
        SquadCodec.State memory next,
        SquadCodec.Action[6] memory actions,
        SquadCodec.Effects memory effects,
        Checkpoints memory trace
    ) private pure {
        uint8[6] memory endpoints;
        bool[6] memory candidates;
        for (uint256 id = 0; id < Parameters.UNIT_COUNT; ++id) {
            endpoints[id] = next.units[id].position;
            SquadCodec.Action memory action = actions[id];
            if (action.actionType == 1 || (action.actionType == 3 && next.units[id].unitType == 3))
            {
                // Static validation bounds the path and its final cell to six bits.
                // forge-lint: disable-next-line(unsafe-typecast)
                endpoints[id] =
                    uint8((action.pathBits >> (uint256(action.pathLength - 1) * 6)) & 63);
                candidates[id] = true;
            }
        }
        for (uint256 id = 0; id < Parameters.UNIT_COUNT; ++id) {
            if (candidates[id]) {
                bool unique = true;
                for (uint256 other = 0; other < Parameters.UNIT_COUNT; ++other) {
                    if (id != other && candidates[other] && endpoints[id] == endpoints[other]) {
                        unique = false;
                    }
                }
                if (unique) {
                    next.units[id].position = endpoints[id];
                    effects.moved[id] = true;
                }
            }
            trace.positions[id] = next.units[id].position;
        }
    }

    function _support(
        SquadCodec.State memory next,
        SquadCodec.Action[6] memory actions,
        SquadCodec.Effects memory effects,
        Checkpoints memory trace
    ) private pure {
        uint8[10] memory skills = Parameters.skillRules();
        for (uint256 id = 0; id < Parameters.UNIT_COUNT; ++id) {
            SquadCodec.Unit memory unit = next.units[id];
            if (!unit.alive || actions[id].actionType != 3) continue;
            if (unit.unitType == 1) trace.shields[id] = skills[0];
            if (unit.unitType == 4) {
                uint8 targetId = actions[id].targetUnit;
                SquadCodec.Unit memory target = next.units[targetId];
                if (target.alive && _distance(unit.position, target.position) <= skills[3]) {
                    uint8 room = Parameters.unitRule(target.unitType)[0] - target.hp;
                    uint8 amount = room < skills[4] ? room : skills[4];
                    next.units[targetId].hp += amount;
                    effects.healed[targetId] += amount;
                }
            }
        }
        for (uint256 id = 0; id < Parameters.UNIT_COUNT; ++id) {
            trace.supportHp[id] = next.units[id].hp;
        }
    }

    function _damage(
        SquadCodec.State memory next,
        SquadCodec.Action[6] memory actions,
        SquadCodec.Effects memory effects,
        Checkpoints memory trace
    ) private pure {
        uint64 cover = Parameters.terrain(next.mapId)[1];
        uint8 coverReduction = Parameters.skillRules()[8];
        for (uint256 id = 0; id < Parameters.UNIT_COUNT; ++id) {
            if (!next.units[id].alive) continue;
            uint8 amount = _attackDamage(next.units[id].unitType, actions[id].actionType);
            if (amount == 0) continue;
            uint256 targetId = _enemyAt(next, id, actions[id].targetCell);
            if (targetId == Parameters.UNIT_COUNT) continue;
            trace.rawDamage[targetId] += amount;
            if (Geometry.contains(cover, next.units[targetId].position)) {
                effects.coverReduced[targetId] += amount < coverReduction ? amount : coverReduction;
            }
        }
        // All sources contribute before any HP changes, including mutually lethal attacks.
        for (uint256 id = 0; id < Parameters.UNIT_COUNT; ++id) {
            uint8 damage = trace.rawDamage[id] - effects.coverReduced[id];
            uint8 shield = trace.shields[id];
            effects.shieldReduced[id] = damage < shield ? damage : shield;
            damage -= effects.shieldReduced[id];
            uint8 hp = next.units[id].hp;
            effects.damageTaken[id] = damage < hp ? damage : hp;
            next.units[id].hp -= effects.damageTaken[id];
            trace.damageHp[id] = next.units[id].hp;
        }
    }

    function _status(
        SquadCodec.State memory next,
        SquadCodec.Action[6] memory actions,
        SquadCodec.Effects memory effects
    ) private pure {
        for (uint256 id = 0; id < Parameters.UNIT_COUNT; ++id) {
            // alive still describes the starting units; a dying caster retains its legal effect.
            if (
                !next.units[id].alive || next.units[id].unitType != 5 || actions[id].actionType != 3
            ) continue;
            uint256 targetId = _enemyAt(next, id, actions[id].targetCell);
            if (targetId != Parameters.UNIT_COUNT) {
                effects.lockedRoundApplied[targetId] = next.completedRound + 2;
            }
        }
    }

    function _worldUpdate(SquadCodec.State memory next, SquadCodec.Effects memory effects)
        private
        pure
    {
        uint64[4] memory terrain = Parameters.terrain(next.mapId);
        uint8[8] memory rules = Parameters.matchRules();
        uint8[2] memory income;
        uint8[2] memory control;
        for (uint256 id = 0; id < Parameters.UNIT_COUNT; ++id) {
            next.units[id].lockedRound = effects.lockedRoundApplied[id];
            next.units[id] = SquadRules.normalizeUnit(next.units[id]);
            if (!next.units[id].alive) continue;
            uint256 side = id / Parameters.SQUAD_SIZE;
            if (Geometry.contains(terrain[2], next.units[id].position)) income[side] += rules[3];
            if (Geometry.contains(terrain[3], next.units[id].position)) ++control[side];
        }
        for (uint256 side = 0; side < 2; ++side) {
            uint8 room = Parameters.MAX_ENERGY - next.energy[side];
            effects.energyGained[side] = income[side] < room ? income[side] : room;
            next.energy[side] += effects.energyGained[side];
        }
        if (control[0] != control[1]) {
            uint256 winner = control[0] > control[1] ? 0 : 1;
            effects.victoryPointsGained[winner] = rules[4];
            next.victoryPoints[winner] += rules[4];
        }
    }

    function _result(SquadCodec.State memory next)
        private
        pure
        returns (uint8 outcome, uint8 reason)
    {
        uint16[2] memory hp;
        for (uint256 id = 0; id < Parameters.UNIT_COUNT; ++id) {
            hp[id / Parameters.SQUAD_SIZE] += next.units[id].hp;
        }
        if (hp[0] == 0 && hp[1] == 0) return (3, 2);
        if (hp[0] == 0) return (2, 1);
        if (hp[1] == 0) return (1, 1);
        uint8 a = next.victoryPoints[0];
        uint8 b = next.victoryPoints[1];
        if (a >= Parameters.matchRules()[6] || b >= Parameters.matchRules()[6]) reason = 3;
        else if (next.completedRound == Parameters.MAX_ROUNDS) reason = 4;
        else return (0, 0);
        if (a > b) outcome = 1;
        else if (b > a) outcome = 2;
        else if (hp[0] > hp[1]) outcome = 1;
        else if (hp[1] > hp[0]) outcome = 2;
        else outcome = 3;
    }

    function _enemyAt(SquadCodec.State memory next, uint256 actor, uint8 cell)
        private
        pure
        returns (uint256)
    {
        uint256 start = actor < Parameters.SQUAD_SIZE ? Parameters.SQUAD_SIZE : 0;
        for (uint256 id = start; id < start + Parameters.SQUAD_SIZE; ++id) {
            if (next.units[id].alive && next.units[id].hp > 0 && next.units[id].position == cell) {
                return id;
            }
        }
        return Parameters.UNIT_COUNT;
    }

    function _attackDamage(uint8 unitType, uint8 actionType) private pure returns (uint8) {
        if (actionType == 2) return Parameters.unitRule(unitType)[3];
        if (actionType == 3 && unitType == 2) return Parameters.skillRules()[1];
        return 0;
    }

    function _distance(uint8 a, uint8 b) private pure returns (uint8) {
        uint8 ax = a % Parameters.BOARD_WIDTH;
        uint8 bx = b % Parameters.BOARD_WIDTH;
        uint8 ay = a / Parameters.BOARD_WIDTH;
        uint8 by = b / Parameters.BOARD_WIDTH;
        return (ax > bx ? ax - bx : bx - ax) + (ay > by ? ay - by : by - ay);
    }
}
// forge-lint: disable-end(literal-instead-of-constant)
