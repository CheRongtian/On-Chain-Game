// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "../src/GameTypes.sol";
import { GameHash } from "../src/GameHash.sol";

// Provides an external call boundary for inspecting canonical-encoding reverts.
contract ActionEncodingProbe {
    function hashActions(GameTypes.Action[3] calldata actions) external pure returns (bytes32) {
        return GameHash.hashActions(actions);
    }
}
