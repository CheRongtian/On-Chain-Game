// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "../src/GameTypes.sol";
import { MapRules } from "../src/MapRules.sol";
import { UnitRules } from "../src/UnitRules.sol";

// Provides an external call boundary for checking static-rule errors locally.
contract RulesProbe {
    function validateActions(
        GameTypes.BattleState calldata state,
        uint8 playerIndex,
        GameTypes.Action[3] calldata actions
    ) external pure returns (uint8) {
        return UnitRules.validateActions(state, playerIndex, actions);
    }

    function cellId(uint8 x, uint8 y) external pure returns (uint8) {
        return MapRules.cellId(x, y);
    }

    function coordinates(uint8 cell) external pure returns (uint8 x, uint8 y) {
        return MapRules.coordinates(cell);
    }
}
