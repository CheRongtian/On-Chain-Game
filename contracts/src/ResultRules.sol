// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "./GameTypes.sol";
import { GameHash } from "./GameHash.sol";

library ResultRules {
    // Evaluate after damage, deaths, and scoring, before advancing a continuing round.
    function evaluate(GameTypes.BattleState memory state)
        internal
        pure
        returns (GameTypes.Outcome outcome, GameTypes.EndReason reason)
    {
        GameHash.validateBattleState(state);
        if (state.outcome != GameTypes.Outcome.None) return (state.outcome, state.reason);

        uint16 hpA = 0;
        uint16 hpB = 0;
        for (uint256 slot = 0; slot < GameTypes.SQUAD_SIZE; ++slot) {
            hpA += state.units[slot].hp;
            hpB += state.units[slot + GameTypes.SQUAD_SIZE].hp;
        }
        if (hpA == 0 && hpB == 0) {
            return (GameTypes.Outcome.Draw, GameTypes.EndReason.MutualElimination);
        }
        if (hpA == 0) return (GameTypes.Outcome.PlayerB, GameTypes.EndReason.Elimination);
        if (hpB == 0) return (GameTypes.Outcome.PlayerA, GameTypes.EndReason.Elimination);

        uint8 vpA = state.players[0].victoryPoints;
        uint8 vpB = state.players[1].victoryPoints;
        if (vpA >= GameTypes.VICTORY_THRESHOLD || vpB >= GameTypes.VICTORY_THRESHOLD) {
            return (_compare(vpA, vpB, hpA, hpB), GameTypes.EndReason.VictoryPoints);
        }
        if (state.round == GameTypes.MAX_ROUNDS) {
            return (_compare(vpA, vpB, hpA, hpB), GameTypes.EndReason.RoundLimit);
        }
        return (GameTypes.Outcome.None, GameTypes.EndReason.None);
    }

    function _compare(uint8 vpA, uint8 vpB, uint16 hpA, uint16 hpB)
        private
        pure
        returns (GameTypes.Outcome)
    {
        if (vpA > vpB) return GameTypes.Outcome.PlayerA;
        if (vpB > vpA) return GameTypes.Outcome.PlayerB;
        if (hpA > hpB) return GameTypes.Outcome.PlayerA;
        if (hpB > hpA) return GameTypes.Outcome.PlayerB;
        return GameTypes.Outcome.Draw;
    }
}
