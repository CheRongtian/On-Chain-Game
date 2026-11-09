// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "./SquadCodec.sol";
import { SquadParameters as Parameters } from "./SquadParameters.sol";

library SquadRules {
    function getMap(uint8 mapId) internal pure returns (SquadCodec.Map memory map) {
        uint64[4] memory masks = Parameters.terrain(mapId);
        map = SquadCodec.Map({
            mapId: mapId,
            width: Parameters.BOARD_WIDTH,
            height: Parameters.BOARD_WIDTH,
            obstacles: masks[0],
            cover: masks[1],
            resources: masks[2],
            controlZone: masks[3],
            spawnsA: Parameters.spawnsA(),
            spawnsB: Parameters.spawnsB(),
            mapHash: bytes32(0)
        });
        map.mapHash = keccak256(
            abi.encode(
                map.mapId,
                map.width,
                map.height,
                map.obstacles,
                map.cover,
                map.resources,
                map.controlZone,
                map.spawnsA,
                map.spawnsB
            )
        );
    }

    function getRules() internal pure returns (SquadCodec.Rules memory rules) {
        rules.semanticsId = Parameters.SEMANTICS_ID;
        rules.matchRules = Parameters.matchRules();
        rules.unitRules = Parameters.unitRules();
        rules.skillRules = Parameters.skillRules();
        rules.windows = Parameters.windows();
        rules.schemas = Parameters.schemas();
        for (uint8 mapId = 1; mapId <= Parameters.MAP_COUNT; ++mapId) {
            rules.mapHashes[mapId - 1] = getMap(mapId).mapHash;
        }
    }

    function rulesetId() internal pure returns (bytes32) {
        return keccak256(SquadCodec.rulesEncoding(getRules()));
    }

    function initialize(uint8 mapId, uint8[3] memory typesA, uint8[3] memory typesB)
        internal
        pure
        returns (SquadCodec.State memory state)
    {
        SquadCodec.validateSquad(typesA);
        SquadCodec.validateSquad(typesB);
        SquadCodec.Map memory map = getMap(mapId);
        state.mapId = mapId;
        state.battleStarted = true;
        state.energy = [Parameters.INITIAL_ENERGY, Parameters.INITIAL_ENERGY];
        for (uint256 slot = 0; slot < Parameters.SQUAD_SIZE; ++slot) {
            state.units[slot] = _spawn(typesA[slot], map.spawnsA[slot]);
            state.units[slot + Parameters.SQUAD_SIZE] = _spawn(typesB[slot], map.spawnsB[slot]);
        }
    }

    function _spawn(uint8 unitType, uint8 cell) private pure returns (SquadCodec.Unit memory) {
        return SquadCodec.Unit(unitType, cell, Parameters.unitRule(unitType)[0], true, 0);
    }

    function normalizeUnit(SquadCodec.Unit memory unit)
        internal
        pure
        returns (SquadCodec.Unit memory)
    {
        uint8 maxHp = Parameters.unitRule(unit.unitType)[0];
        // Each unit must retain its HP guard when normalization runs inside settlement loops.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (unit.hp > maxHp) revert SquadCodec.InvalidProtocol();
        if (unit.hp == 0) {
            unit.position = Parameters.UNUSED_CELL;
            unit.alive = false;
            unit.lockedRound = 0;
        } else if (
            !unit.alive || unit.position >= Parameters.CELL_COUNT
                || unit.lockedRound > Parameters.MAX_ROUNDS + 1
        ) {
            // Invalid live-unit fields must reject even when this helper is called in a loop.
            // forge-lint: disable-next-line(require-revert-in-loop)
            revert SquadCodec.InvalidProtocol();
        }
        return unit;
    }

    function hashState(SquadCodec.Context memory context, SquadCodec.State memory state)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            SquadCodec.stateEncoding(SquadCodec.StateInput(context, rulesetId(), state))
        );
    }
}
