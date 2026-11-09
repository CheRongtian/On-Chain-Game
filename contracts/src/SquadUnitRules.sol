// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "./SquadCodec.sol";
import { SquadMapRules as Geometry } from "./SquadMapRules.sol";
import { SquadParameters as Parameters } from "./SquadParameters.sol";

// Action/type codes and rule-array indices follow the frozen protocol configuration.
// forge-lint: disable-start(literal-instead-of-constant)
library SquadUnitRules {
    function validateActions(
        SquadCodec.State memory state,
        uint8 side,
        SquadCodec.Action[3] memory actions
    ) internal pure returns (uint8 requiredEnergy) {
        if (
            side > 1 || !state.battleStarted || state.outcome != 0
                || state.completedRound >= Parameters.MAX_ROUNDS
        ) revert SquadCodec.InvalidProtocol();
        SquadCodec.validateState(state);
        SquadCodec.ActionInput memory input;
        input.round = state.completedRound + 1;
        input.side = side;
        input.actions = actions;
        for (uint256 slot = 0; slot < Parameters.SQUAD_SIZE; ++slot) {
            SquadCodec.Unit memory unit = state.units[uint256(side) * Parameters.SQUAD_SIZE + slot];
            input.unitTypes[slot] = unit.unitType;
            input.alive[slot] = unit.alive;
            input.lockedRound[slot] = unit.lockedRound;
        }
        SquadCodec.validateActions(input);
        uint64 obstacles = Parameters.terrain(state.mapId)[0];
        uint64 blocked = obstacles;
        for (uint256 id = 0; id < Parameters.UNIT_COUNT; ++id) {
            if (state.units[id].alive) blocked |= uint64(1) << state.units[id].position;
        }
        for (uint256 slot = 0; slot < Parameters.SQUAD_SIZE; ++slot) {
            SquadCodec.Unit memory unit = state.units[uint256(side) * Parameters.SQUAD_SIZE + slot];
            if (!_validGeometry(unit, actions[slot], obstacles, blocked)) {
                // Any invalid slot must reject the complete fixed-size bundle.
                // forge-lint: disable-next-line(require-revert-in-loop)
                revert SquadCodec.InvalidProtocol();
            }
            if (actions[slot].actionType == 3) {
                requiredEnergy += Parameters.unitRule(unit.unitType)[4];
            }
        }
        if (requiredEnergy > state.energy[side]) revert SquadCodec.InvalidProtocol();
    }

    function _validGeometry(
        SquadCodec.Unit memory unit,
        SquadCodec.Action memory action,
        uint64 obstacles,
        uint64 blocked
    ) private pure returns (bool) {
        if (action.actionType == 0) return true;
        bool skill = action.actionType == 3;
        uint8[5] memory rules = Parameters.unitRule(unit.unitType);
        if (action.actionType == 1 || (skill && unit.unitType == 3)) {
            return Geometry.isValidPath(
                unit.position,
                action.pathLength,
                action.pathBits,
                skill ? Parameters.skillRules()[2] : rules[1],
                blocked
            );
        }
        if (action.actionType == 2 || (skill && (unit.unitType == 2 || unit.unitType == 5))) {
            if (unit.unitType == 2 || (skill && unit.unitType == 5)) {
                uint8 range = unit.unitType == 2 ? rules[2] : Parameters.skillRules()[5];
                return Geometry.isClearRay(unit.position, action.targetCell, range, obstacles);
            }
            return Geometry.isAdjacent(unit.position, action.targetCell);
        }
        // Canonical validation already checked Shield and Heal identities. Heal distance uses moved positions.
        return true;
    }
}
// forge-lint: disable-end(literal-instead-of-constant)
