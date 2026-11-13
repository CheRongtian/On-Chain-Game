// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "./SquadCodec.sol";
import { SquadBattleResolver } from "./SquadBattleResolver.sol";

// Keep the reviewed pure resolver out of the Arena runtime without changing its rule fixtures.
library SquadSettlement {
    function resolve(SquadCodec.State memory initial, SquadCodec.Action[3][2] memory actions)
        external
        pure
        returns (SquadCodec.State memory next, SquadCodec.Effects memory effects)
    {
        (next, effects,) = SquadBattleResolver.resolve(initial, actions);
    }
}
