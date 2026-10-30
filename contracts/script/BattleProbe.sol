// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "../src/GameTypes.sol";
import { BattleResolver } from "../src/BattleResolver.sol";

// An ordinary call boundary lets local checks inspect exact resolver rejection errors.
contract BattleProbe {
    function resolve(
        GameTypes.BattleState calldata state,
        GameTypes.Action[3] calldata actionsA,
        GameTypes.Action[3] calldata actionsB
    )
        external
        pure
        returns (GameTypes.BattleState memory next, GameTypes.ResolutionSummary memory summary)
    {
        return BattleResolver.resolve(state, actionsA, actionsB);
    }
}
