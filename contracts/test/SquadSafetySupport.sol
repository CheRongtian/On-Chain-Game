// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "../src/SquadCodec.sol";
import { SquadParameters as Parameters } from "../src/SquadParameters.sol";
import { SquadRules } from "../src/SquadRules.sol";
import { SquadMapRules as Geometry } from "../src/SquadMapRules.sol";
import { SquadUnitRules } from "../src/SquadUnitRules.sol";
import { SquadBattleProbe } from "../script/CheckSquadBattle.s.sol";

// Fixed schema dimensions, bounded assertions and per-unit helper calls are intentional in fixtures.
// forge-lint: disable-start(literal-instead-of-constant,require-revert-in-loop,calls-loop)
library SquadSafetySupport {
    error RuleCallFailure(string expectation, bytes input, bytes result);
    error RuleSafetyFailure(string field, uint256 index, bytes frame);

    function context() internal pure returns (SquadCodec.Context memory) {
        return SquadCodec.Context(31337, address(0xA11CE), 1);
    }

    function nextSeed(uint256 seed) internal pure returns (uint256) {
        unchecked {
            return seed * 1_664_525 + 1_013_904_223;
        }
    }

    function lineup(uint256 seed) internal pure returns (uint8[3] memory types_) {
        // The remainders enumerate 5 * 4 * 3 ordered distinct professions.
        // forge-lint: disable-next-line(unsafe-typecast)
        types_[0] = uint8(1 + seed % 5);
        // forge-lint: disable-next-line(unsafe-typecast)
        types_[1] = uint8(1 + (seed / 5) % 4);
        if (types_[1] >= types_[0]) ++types_[1];
        uint256 rank = (seed / 20) % 3;
        for (uint8 code = 1; code <= Parameters.TYPE_COUNT; ++code) {
            if (code == types_[0] || code == types_[1]) continue;
            if (rank == 0) {
                types_[2] = code;
                break;
            }
            --rank;
        }
    }

    function initialized(uint8 mapId, uint256 seed)
        internal
        pure
        returns (SquadCodec.State memory)
    {
        return SquadRules.initialize(mapId, lineup(seed % 60), lineup((seed / 60) % 60));
    }

    function sample(uint256 seed) internal pure returns (SquadCodec.State memory state) {
        // These are canonical kernel snapshots; exported complete games use actual birth initialization.
        // forge-lint: disable-next-line(unsafe-typecast)
        state = initialized(uint8(1 + seed % 3), seed / 3);
        // forge-lint: disable-next-line(unsafe-typecast)
        state.completedRound = uint16(1 + (seed / 180) % 18);
        uint64 used = Parameters.terrain(state.mapId)[0];
        for (uint256 id = 0; id < Parameters.UNIT_COUNT; ++id) {
            seed = nextSeed(seed);
            for (uint256 offset = 0; offset < Parameters.CELL_COUNT; ++offset) {
                // The modulo bounds the candidate to one board cell.
                // forge-lint: disable-next-line(unsafe-typecast)
                uint8 cell = uint8((seed % 64 + offset) % 64);
                if (!Geometry.contains(used, cell)) {
                    state.units[id].position = cell;
                    used |= uint64(1) << cell;
                    break;
                }
            }
            uint8 maxHp = Parameters.unitRule(state.units[id].unitType)[0];
            // HP is selected within the profession limit.
            // forge-lint: disable-next-line(unsafe-typecast)
            state.units[id].hp = uint8(1 + (seed >> 8) % maxHp);
            state.units[id].lockedRound = (seed >> 16) % 4 == 0 ? state.completedRound + 1 : 0;
        }
        for (uint256 side = 0; side < 2; ++side) {
            seed = nextSeed(seed);
            // Both remainders stay within the configured resource limits.
            // forge-lint: disable-next-line(unsafe-typecast)
            state.energy[side] = uint8(seed % 6);
            // forge-lint: disable-next-line(unsafe-typecast)
            state.victoryPoints[side] = uint8(2 * ((seed >> 8) % 6));
        }
        SquadCodec.validateState(state);
    }

    function hold() internal pure returns (SquadCodec.Action memory action) {
        action.targetCell = Parameters.UNUSED_CELL;
        action.targetUnit = Parameters.UNUSED_CELL;
    }

    function holds() internal pure returns (SquadCodec.Action[3][2] memory actions) {
        for (uint256 side = 0; side < 2; ++side) {
            for (uint256 slot = 0; slot < 3; ++slot) {
                actions[side][slot] = hold();
            }
        }
    }

    function allMoves(SquadCodec.State memory state)
        internal
        pure
        returns (SquadCodec.Action[3][2] memory actions)
    {
        uint64 blocked = Parameters.terrain(state.mapId)[0];
        for (uint256 id = 0; id < 6; ++id) {
            if (state.units[id].alive) blocked |= uint64(1) << state.units[id].position;
        }
        actions = holds();
        for (uint256 id = 0; id < 6; ++id) {
            uint8 kind = state.units[id].unitType == 3 ? 3 : 1;
            uint8 limit = kind == 3
                ? Parameters.skillRules()[2]
                : Parameters.unitRule(state.units[id].unitType)[1];
            uint256 seed = (uint256(limit - 1) << 24) | (id < 3 ? 0x55 : 0xff);
            actions[id / 3][id % 3] = _path(state.units[id].position, kind, limit, blocked, seed);
        }
    }

    function preludeState() internal pure returns (SquadCodec.State memory state) {
        state = SquadRules.initialize(1, [uint8(1), 4, 3], [uint8(2), 5, 1]);
        state.completedRound = 18;
        state.energy = [uint8(5), 5];
        uint8[6] memory positions = [uint8(0), 8, 4, 2, 1, 3];
        for (uint256 id = 0; id < 6; ++id) {
            state.units[id].position = positions[id];
        }
        state.units[0].hp = 1;
    }

    function preludeOrders(bool second)
        internal
        pure
        returns (SquadCodec.Action[3][2] memory actions)
    {
        actions = holds();
        if (!second) {
            for (uint256 side = 0; side < 2; ++side) {
                for (uint256 slot = 0; slot < 3; ++slot) {
                    actions[side][slot].actionType = 3;
                }
            }
            actions[0][1].targetUnit = 0;
            actions[0][2].pathLength = 4;
            actions[0][2].pathBits =
                uint32(12) | (uint32(20) << 6) | (uint32(21) << 12) | (uint32(29) << 18);
            actions[1][0].targetCell = 0;
            actions[1][1].targetCell = 0;
        } else {
            actions[0][0].actionType = 2;
            actions[0][0].targetCell = 1;
            actions[0][2].actionType = 1;
            actions[0][2].pathLength = 3;
            actions[0][2].pathBits = uint32(21) | (uint32(13) << 6) | (uint32(5) << 12);
            for (uint256 slot = 0; slot < 3; ++slot) {
                actions[1][slot].actionType = 2;
                actions[1][slot].targetCell = slot == 2 ? 4 : 0;
            }
        }
    }

    function swapState(SquadCodec.State memory state)
        internal
        pure
        returns (SquadCodec.State memory swapped)
    {
        swapped = abi.decode(abi.encode(state), (SquadCodec.State));
        for (uint256 slot = 0; slot < 3; ++slot) {
            SquadCodec.Unit memory unit = state.units[slot];
            swapped.units[slot] = state.units[slot + 3];
            swapped.units[slot + 3] = unit;
        }
        swapped.energy = [state.energy[1], state.energy[0]];
        swapped.victoryPoints = [state.victoryPoints[1], state.victoryPoints[0]];
        swapped.outcome = state.outcome == 1 ? 2 : state.outcome == 2 ? 1 : state.outcome;
    }

    function swapActions(SquadCodec.Action[3][2] memory actions)
        internal
        pure
        returns (SquadCodec.Action[3][2] memory swapped)
    {
        swapped = abi.decode(abi.encode(actions), (SquadCodec.Action[3][2]));
        for (uint256 side = 0; side < 2; ++side) {
            for (uint256 slot = 0; slot < 3; ++slot) {
                swapped[side][slot] =
                    abi.decode(abi.encode(actions[1 - side][slot]), (SquadCodec.Action));
                if (swapped[side][slot].targetUnit < 6) {
                    swapped[side][slot].targetUnit = (swapped[side][slot].targetUnit + 3) % 6;
                }
            }
        }
    }

    function sameEffects(SquadCodec.Effects memory a, SquadCodec.Effects memory b)
        internal
        pure
        returns (bool)
    {
        for (uint256 side = 0; side < 2; ++side) {
            if (
                a.energySpent[side] != b.energySpent[side]
                    || a.energyGained[side] != b.energyGained[side]
                    || a.victoryPointsGained[side] != b.victoryPointsGained[side]
            ) return false;
        }
        for (uint256 id = 0; id < 6; ++id) {
            if (
                a.moved[id] != b.moved[id] || a.healed[id] != b.healed[id]
                    || a.coverReduced[id] != b.coverReduced[id]
                    || a.shieldReduced[id] != b.shieldReduced[id]
                    || a.damageTaken[id] != b.damageTaken[id]
                    || a.lockedRoundApplied[id] != b.lockedRoundApplied[id]
            ) return false;
        }
        return true;
    }

    function swapEffects(SquadCodec.Effects memory effects)
        internal
        pure
        returns (SquadCodec.Effects memory swapped)
    {
        for (uint256 side = 0; side < 2; ++side) {
            swapped.energySpent[side] = effects.energySpent[1 - side];
            swapped.energyGained[side] = effects.energyGained[1 - side];
            swapped.victoryPointsGained[side] = effects.victoryPointsGained[1 - side];
        }
        for (uint256 id = 0; id < 6; ++id) {
            uint256 other = (id + 3) % 6;
            swapped.moved[id] = effects.moved[other];
            swapped.healed[id] = effects.healed[other];
            swapped.coverReduced[id] = effects.coverReduced[other];
            swapped.shieldReduced[id] = effects.shieldReduced[other];
            swapped.damageTaken[id] = effects.damageTaken[other];
            swapped.lockedRoundApplied[id] = effects.lockedRoundApplied[other];
        }
    }

    function generate(SquadCodec.State memory state, uint256 seed)
        internal
        pure
        returns (SquadCodec.Action[3][2] memory actions)
    {
        actions = holds();
        uint64 blocked = Parameters.terrain(state.mapId)[0];
        for (uint256 id = 0; id < 6; ++id) {
            if (state.units[id].alive) blocked |= uint64(1) << state.units[id].position;
        }
        for (uint8 side = 0; side < 2; ++side) {
            uint8 remaining = state.energy[side];
            for (uint256 slot = 0; slot < 3; ++slot) {
                seed = nextSeed(seed);
                (SquadCodec.Action memory action, uint8 cost) =
                    _action(state, uint256(side) * 3 + slot, blocked, seed, remaining);
                actions[side][slot] = action;
                remaining -= cost;
            }
            SquadUnitRules.validateActions(state, side, actions[side]);
        }
    }

    // Enumerating all professions and action kinds is the purpose of this test-only generator.
    // forge-lint: disable-next-item(cyclomatic-complexity)
    function _action(
        SquadCodec.State memory state,
        uint256 id,
        uint64 blocked,
        uint256 seed,
        uint8 remaining
    ) private pure returns (SquadCodec.Action memory action, uint8 cost) {
        action = hold();
        SquadCodec.Unit memory unit = state.units[id];
        if (!unit.alive) return (action, 0);
        // The selected code is one of the four frozen action kinds.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint8 kind = uint8((seed >> 16) % 4);
        if (kind == 0) return (action, 0);
        if (kind == 3) {
            cost = Parameters.unitRule(unit.unitType)[4];
            if (cost > remaining || unit.lockedRound == state.completedRound + 1) {
                return (action, 0);
            }
        }
        if (kind == 1 || (kind == 3 && unit.unitType == 3)) {
            uint8 limit =
                kind == 3 ? Parameters.skillRules()[2] : Parameters.unitRule(unit.unitType)[1];
            action = _path(unit.position, kind, limit, blocked, seed);
            return (action, action.actionType == 0 ? 0 : cost);
        }
        action.actionType = kind;
        if (kind == 3 && unit.unitType == 1) return (action, cost);
        if (kind == 3 && unit.unitType == 4) {
            uint256 start = id - id % 3;
            for (uint256 offset = 0; offset < 3; ++offset) {
                uint256 target = start + (seed % 3 + offset) % 3;
                if (state.units[target].alive) {
                    // The target is a fixed friendly slot in 0..5.
                    // forge-lint: disable-next-line(unsafe-typecast)
                    action.targetUnit = uint8(target);
                    return (action, cost);
                }
            }
        }
        bool ray = unit.unitType == 2 || (kind == 3 && unit.unitType == 5);
        uint8 range = kind == 3 && unit.unitType == 5
            ? Parameters.skillRules()[5]
            : Parameters.unitRule(unit.unitType)[2];
        action.targetCell = _target(state, id, range, ray, seed);
        if (action.targetCell == Parameters.UNUSED_CELL) return (hold(), 0);
    }

    function _target(SquadCodec.State memory state, uint256 id, uint8 range, bool ray, uint256 seed)
        private
        pure
        returns (uint8)
    {
        uint64 obstacles = Parameters.terrain(state.mapId)[0];
        for (uint256 offset = 0; offset < 67; ++offset) {
            uint8 cell;
            if (offset < 3) {
                cell = state.units[(1 - id / 3) * 3 + (seed % 3 + offset) % 3].position;
            } else {
                // The modulo bounds fallback targets to 0..63.
                // forge-lint: disable-next-line(unsafe-typecast)
                cell = uint8((seed % 64 + offset - 3) % 64);
            }
            bool valid = ray
                ? Geometry.isClearRay(state.units[id].position, cell, range, obstacles)
                : Geometry.isAdjacent(state.units[id].position, cell);
            if (valid) return cell;
        }
        return Parameters.UNUSED_CELL;
    }

    function _path(uint8 origin, uint8 kind, uint8 limit, uint64 blocked, uint256 seed)
        private
        pure
        returns (SquadCodec.Action memory action)
    {
        action = hold();
        uint64 visited = uint64(1) << origin;
        uint8 previous = origin;
        uint256 length = 1 + (seed >> 24) % limit;
        for (uint256 step = 0; step < length; ++step) {
            uint8 cell = _neighbor(previous, blocked | visited, seed >> (step * 2));
            if (cell == Parameters.UNUSED_CELL) break;
            // Four six-bit cells fit the frozen 24-bit path payload.
            // forge-lint: disable-next-line(unsafe-typecast)
            action.pathBits |= uint32(uint256(cell) << (step * 6));
            ++action.pathLength;
            visited |= uint64(1) << cell;
            previous = cell;
        }
        if (action.pathLength > 0) action.actionType = kind;
    }

    function _neighbor(uint8 previous, uint64 blocked, uint256 seed) private pure returns (uint8) {
        for (uint256 offset = 0; offset < 4; ++offset) {
            uint256 direction = (seed % 4 + offset) % 4;
            uint8 cell = 0;
            if (direction == 0 && previous >= 8) cell = previous - 8;
            else if (direction == 1 && previous % 8 < 7) cell = previous + 1;
            else if (direction == 2 && previous < 56) cell = previous + 8;
            else if (direction == 3 && previous % 8 > 0) cell = previous - 1;
            else continue;
            if (!Geometry.contains(blocked, cell)) return cell;
        }
        return Parameters.UNUSED_CELL;
    }

    function run(
        SquadBattleProbe probe,
        SquadCodec.Context memory ctx,
        SquadCodec.State memory state,
        SquadCodec.Action[3][2] memory actions
    ) internal view returns (SquadBattleProbe.Output memory output) {
        bytes memory input =
            abi.encode(SquadBattleProbe.Input({ context: ctx, state: state, actions: actions }));
        try probe.evaluate(0, input) returns (bytes memory result) {
            output = abi.decode(result, (SquadBattleProbe.Output));
        } catch (bytes memory reason) {
            revert RuleCallFailure("Valid input reverted", input, reason);
        }
        if (!sameState(output.initial, state)) {
            revert RuleCallFailure("Resolver changed input state", input, abi.encode(output));
        }
        for (uint256 side = 0; side < 2; ++side) {
            for (uint256 slot = 0; slot < 3; ++slot) {
                SquadCodec.Action memory a = output.actions[side][slot];
                SquadCodec.Action memory b = actions[side][slot];
                if (!(a.actionType == b.actionType && a.targetCell == b.targetCell
                            && a.targetUnit == b.targetUnit && a.pathLength == b.pathLength
                            && a.pathBits == b.pathBits)) {
                    revert RuleCallFailure(
                        "Resolver changed input action", input, abi.encode(output)
                    );
                }
            }
        }
        checkTransition(state, actions, output);
    }

    function reject(
        SquadBattleProbe probe,
        SquadCodec.State memory state,
        SquadCodec.Action[3][2] memory actions
    ) internal view {
        bytes memory input = abi.encode(
            SquadBattleProbe.Input({ context: context(), state: state, actions: actions })
        );
        try probe.evaluate(0, input) returns (bytes memory result) {
            revert RuleCallFailure("Invalid rule input accepted", input, result);
        } catch (bytes memory reason) {
            if (reason.length != 4) {
                revert RuleCallFailure("Expected explicit protocol error, no panic", input, reason);
            }
            // The length guard ensures the complete four-byte error selector is present.
            // forge-lint: disable-next-line(unsafe-typecast)
            if (bytes4(reason) != SquadCodec.InvalidProtocol.selector) {
                revert RuleCallFailure("Wrong rule rejection", input, reason);
            }
        }
    }

    function sameState(SquadCodec.State memory a, SquadCodec.State memory b)
        internal
        pure
        returns (bool)
    {
        if (
            a.mapId != b.mapId || a.battleStarted != b.battleStarted
                || a.completedRound != b.completedRound || a.outcome != b.outcome
                || a.reason != b.reason
        ) return false;
        for (uint256 side = 0; side < 2; ++side) {
            if (a.energy[side] != b.energy[side] || a.victoryPoints[side] != b.victoryPoints[side]) return false;
        }
        for (uint256 id = 0; id < 6; ++id) {
            SquadCodec.Unit memory x = a.units[id];
            SquadCodec.Unit memory y = b.units[id];
            if (
                x.unitType != y.unitType || x.position != y.position || x.hp != y.hp
                    || x.alive != y.alive || x.lockedRound != y.lockedRound
            ) return false;
        }
        return true;
    }

    function checkState(SquadCodec.State memory state) internal pure {
        SquadCodec.validateState(state);
        for (uint256 side = 0; side < 2; ++side) {
            require(
                state.victoryPoints[side] <= Parameters.matchRules()[6],
                "Score exceeds reachable threshold"
            );
        }
    }

    // Each branch is an independent rule assertion with its own reproducible failure frame.
    // forge-lint: disable-next-item(cyclomatic-complexity)
    function checkTransition(
        SquadCodec.State memory before_,
        SquadCodec.Action[3][2] memory actions,
        SquadBattleProbe.Output memory output
    ) internal pure {
        SquadCodec.State memory after_ = output.next;
        if (!(after_.mapId == before_.mapId && after_.battleStarted)) {
            _fail(output, 6, "Battle identity changed");
        }
        _checkMovement(before_, actions, output);
        if (!(after_.completedRound == before_.completedRound + 1)) {
            _fail(output, 6, "Round did not advance once");
        }
        uint8[2] memory income;
        uint8[2] memory control;
        uint64[4] memory terrain = Parameters.terrain(after_.mapId);
        for (uint256 id = 0; id < 6; ++id) {
            _checkUnit(before_.units[id], after_.units[id], actions[id / 3][id % 3], id, output);
            if (!after_.units[id].alive) continue;
            if (Geometry.contains(terrain[2], after_.units[id].position)) ++income[id / 3];
            if (Geometry.contains(terrain[3], after_.units[id].position)) ++control[id / 3];
        }
        for (uint256 side = 0; side < 2; ++side) {
            uint8 spent = 0;
            for (uint256 slot = 0; slot < 3; ++slot) {
                if (actions[side][slot].actionType == 3) {
                    spent += Parameters.unitRule(before_.units[side * 3 + slot].unitType)[4];
                }
            }
            if (!(output.effects.energySpent[side] == spent && spent <= before_.energy[side])) {
                _fail(output, side, "Skill budget changed");
            }
            uint8 energy = before_.energy[side] - spent;
            uint8 credited = income[side] < Parameters.MAX_ENERGY - energy
                ? income[side]
                : Parameters.MAX_ENERGY - energy;
            if (!(after_.energy[side] == energy + credited
                        && output.effects.energyGained[side] == credited)) {
                _fail(output, side, "Resource accounting differs");
            }
            uint8 points = control[side] > control[1 - side] ? Parameters.matchRules()[4] : 0;
            if (!(after_.victoryPoints[side] == before_.victoryPoints[side] + points
                        && output.effects.victoryPointsGained[side] == points)) {
                _fail(output, side, "Control accounting differs");
            }
        }
        if (!(output.trace.activeRound
                    == (after_.outcome == 0 ? after_.completedRound + 1 : after_.completedRound))) {
            _fail(output, 6, "Active round differs");
        }
        checkState(after_);
    }

    function _checkMovement(
        SquadCodec.State memory before_,
        SquadCodec.Action[3][2] memory actions,
        SquadBattleProbe.Output memory output
    ) private pure {
        uint8[64] memory counts;
        uint8[6] memory endpoints;
        bool[6] memory candidates;
        for (uint256 id = 0; id < 6; ++id) {
            SquadCodec.Action memory action = actions[id / 3][id % 3];
            candidates[id] = action.actionType == 1
                || (action.actionType == 3 && before_.units[id].unitType == 3);
            if (!candidates[id]) continue;
            // Accepted paths contain a final cell in the low six-bit word.
            // forge-lint: disable-next-line(unsafe-typecast)
            endpoints[id] = uint8((action.pathBits >> (uint256(action.pathLength - 1) * 6)) & 63);
            ++counts[endpoints[id]];
        }
        for (uint256 id = 0; id < 6; ++id) {
            if (!(output.effects.moved[id] == (candidates[id] && counts[endpoints[id]] == 1))) {
                _fail(output, id, "Shared endpoints or unique move resolved incorrectly");
            }
        }
    }

    // Keep each unit's bounded settlement assertions beside the field they diagnose.
    // forge-lint: disable-next-item(cyclomatic-complexity)
    function _checkUnit(
        SquadCodec.Unit memory before_,
        SquadCodec.Unit memory after_,
        SquadCodec.Action memory action,
        uint256 id,
        SquadBattleProbe.Output memory output
    ) private pure {
        if (!(before_.unitType == after_.unitType)) {
            _fail(output, id, "Profession changed");
        }
        uint8 healed = output.effects.healed[id];
        if (!(healed <= Parameters.skillRules()[4]
                    && output.trace.supportHp[id] == before_.hp + healed)) {
            _fail(output, id, "Support accounting differs");
        }
        uint8 raw = output.trace.rawDamage[id];
        uint8 cover = output.effects.coverReduced[id];
        if (!(cover <= raw)) _fail(output, id, "Cover exceeds damage");
        uint8 remaining = raw - cover;
        uint8 shield = output.trace.shields[id];
        if (!(shield
                    == (before_.alive && before_.unitType == 1 && action.actionType == 3
                            ? Parameters.skillRules()[0]
                            : 0))) _fail(output, id, "Shield registration differs");
        uint8 shieldUsed = remaining < shield ? remaining : shield;
        if (!(output.effects.shieldReduced[id] == shieldUsed)) {
            _fail(output, id, "Shield accounting differs");
        }
        remaining -= shieldUsed;
        uint8 supportHp = output.trace.supportHp[id];
        uint8 lost = remaining < supportHp ? remaining : supportHp;
        if (!(output.effects.damageTaken[id] == lost && after_.hp == supportHp - lost
                    && output.trace.damageHp[id] == after_.hp)) {
            _fail(output, id, "Damage accounting differs");
        }
        bool moves = action.actionType == 1 || (action.actionType == 3 && before_.unitType == 3);
        if (output.effects.moved[id]) {
            if (!(moves)) _fail(output, id, "Nonmoving action moved");
            // The validated path endpoint occupies only six bits.
            // forge-lint: disable-next-line(unsafe-typecast)
            if (!(output.trace.positions[id]
                        == uint8((action.pathBits >> (uint256(action.pathLength - 1) * 6)) & 63))) {
                _fail(output, id, "Move endpoint differs");
            }
        } else {
            if (!(output.trace.positions[id] == before_.position)) {
                _fail(output, id, "Failed move changed position");
            }
        }
        if (!(after_.position
                    == (after_.alive ? output.trace.positions[id] : Parameters.UNUSED_CELL))) {
            _fail(output, id, "Death position differs");
        }
        if (!(after_.lockedRound == output.effects.lockedRoundApplied[id])) {
            _fail(output, id, "Old lock survived or new lock lost");
        }
    }

    function _fail(SquadBattleProbe.Output memory output, uint256 index, string memory field)
        private
        pure
    {
        revert RuleSafetyFailure(field, index, abi.encode(output));
    }
}
// forge-lint: disable-end(literal-instead-of-constant,require-revert-in-loop,calls-loop)
