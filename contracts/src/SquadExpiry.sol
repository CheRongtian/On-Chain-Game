// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "./SquadCodec.sol";
import { SquadProtocol as Protocol } from "./SquadProtocol.sol";

library SquadExpiry {
    uint8 private constant DRAW = 3;
    uint8 private constant COMMIT_TIMEOUT = 5;
    uint8 private constant REVEAL_TIMEOUT = 6;
    uint8 private constant SQUAD_COMMIT_TIMEOUT = 7;
    uint8 private constant SQUAD_REVEAL_TIMEOUT = 8;

    function cancel(SquadCodec.MatchSummary storage summary, uint256 matchId) internal {
        Protocol.requirePhase(summary, Protocol.WAITING);
        if (msg.sender != summary.players[0]) revert Protocol.NotCreator(msg.sender);
        Protocol.advance(summary, matchId, Protocol.CANCELLED, 0);
    }

    function expire(SquadCodec.MatchSummary storage summary, uint256 matchId) internal {
        Protocol.requirePhase(summary, Protocol.WAITING);
        Protocol.requireExpired(summary.joinDeadline);
        Protocol.advance(summary, matchId, Protocol.EXPIRED, 0);
    }

    function timeout(
        SquadCodec.MatchData storage matchData,
        uint256 matchId,
        uint16 round,
        uint8 expectedPhase
    ) internal {
        if (
            expectedPhase != Protocol.SQUAD_COMMIT && expectedPhase != Protocol.SQUAD_REVEAL
                && expectedPhase != Protocol.ROUND_COMMIT && expectedPhase != Protocol.ROUND_REVEAL
        ) {
            revert Protocol.InvalidTimeoutPhase(expectedPhase);
        }
        SquadCodec.MatchSummary storage summary = matchData.summary;
        Protocol.requirePhase(summary, expectedPhase);
        Protocol.requireRound(summary, round);
        Protocol.requireExpired(summary.phaseDeadline);
        (bool a, bool b, uint8 reason) = _submissions(matchData, expectedPhase);
        uint8 outcome = a == b ? DRAW : a ? 1 : 2;
        matchData.battle.outcome = outcome;
        matchData.battle.reason = reason;
        summary.outcome = outcome;
        summary.reason = reason;
        summary.stateHash = keccak256(
            abi.encode(
                SquadCodec.domain(3),
                SquadCodec.Context(block.chainid, address(this), matchId),
                summary.rulesetId,
                matchData.battle
            )
        );
        Protocol.finish(matchData, matchId);
    }

    function _submissions(SquadCodec.MatchData storage matchData, uint8 phase)
        private
        view
        returns (bool a, bool b, uint8 reason)
    {
        if (phase == Protocol.SQUAD_COMMIT) {
            return
                (matchData.squad.committed[0], matchData.squad.committed[1], SQUAD_COMMIT_TIMEOUT);
        }
        if (phase == Protocol.SQUAD_REVEAL) {
            return (matchData.squad.revealed[0], matchData.squad.revealed[1], SQUAD_REVEAL_TIMEOUT);
        }
        if (phase == Protocol.ROUND_COMMIT) {
            return (matchData.turn.committed[0], matchData.turn.committed[1], COMMIT_TIMEOUT);
        }
        return (matchData.turn.revealed[0], matchData.turn.revealed[1], REVEAL_TIMEOUT);
    }
}
