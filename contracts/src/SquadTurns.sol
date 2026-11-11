// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "./SquadCodec.sol";
import { SquadProtocol as Protocol } from "./SquadProtocol.sol";
import { SquadParameters as Parameters } from "./SquadParameters.sol";
import { SquadUnitRules } from "./SquadUnitRules.sol";
import { SquadBattleResolver } from "./SquadBattleResolver.sol";
import { ISquadEvents } from "./ISquadArena.sol";

// Tuple dimensions, domain indices and bit offsets follow the frozen protocol layout.
// forge-lint: disable-start(literal-instead-of-constant)
library SquadTurns {
    uint256 private constant ACTION_BITS = 64;
    uint256 private constant BYTE_BITS = 8;

    function commit(
        SquadCodec.MatchData storage matchData,
        uint256 matchId,
        uint16 round,
        bytes32 commitment
    ) internal {
        uint8 side = _submission(matchData.summary, round, Protocol.ROUND_COMMIT);
        SquadCodec.RoundStatus storage turn = matchData.turn;
        if (turn.committed[side]) revert Protocol.AlreadyCommitted(msg.sender);
        turn.commitments[side] = commitment;
        turn.committed[side] = true;
        emit ISquadEvents.ActionCommitted(matchId, round, msg.sender, commitment);
        if (turn.committed[0] && turn.committed[1]) {
            Protocol.advance(
                matchData.summary,
                matchId,
                Protocol.ROUND_REVEAL,
                Protocol.deadlineAfter(Parameters.windows()[4])
            );
        }
    }

    function reveal(
        SquadCodec.MatchData storage matchData,
        uint256 matchId,
        uint16 round,
        SquadCodec.Action[3] calldata actions,
        bytes32 salt
    ) internal {
        uint8 side = _submission(matchData.summary, round, Protocol.ROUND_REVEAL);
        SquadCodec.RoundStatus storage turn = matchData.turn;
        if (turn.revealed[side]) revert Protocol.AlreadyRevealed(msg.sender);
        // Static validation below checks canonical fields against the unchanged round-start state.
        bytes32 commitment = keccak256(
            abi.encode(
                SquadCodec.domain(2),
                _context(matchId),
                round,
                msg.sender,
                matchData.summary.rulesetId,
                actions,
                salt
            )
        );
        if (commitment != turn.commitments[side]) revert Protocol.CommitmentMismatch();
        SquadUnitRules.validateActions(matchData.battle, side, actions);
        matchData.revealedActions[side] = _pack(actions);
        turn.revealed[side] = true;
        emit ISquadEvents.ActionRevealed(matchId, round, msg.sender, actions, salt);
        if (turn.revealed[0] && turn.revealed[1]) {
            Protocol.advance(matchData.summary, matchId, Protocol.RESOLVABLE, 0);
        }
    }

    function settle(SquadCodec.MatchData storage matchData, uint256 matchId, uint16 round)
        internal
    {
        SquadCodec.MatchSummary storage summary = matchData.summary;
        Protocol.requirePhase(summary, Protocol.RESOLVABLE);
        _requireRound(summary, round);
        SquadCodec.Action[3][2] memory actions;
        actions[0] = _unpack(matchData.revealedActions[0]);
        actions[1] = _unpack(matchData.revealedActions[1]);
        bytes32 beforeHash = summary.stateHash;
        (SquadCodec.State memory next, SquadCodec.Effects memory effects,) =
            SquadBattleResolver.resolve(matchData.battle, actions);
        Protocol.storeBattle(matchData.battle, next);
        summary.stateHash = keccak256(
            abi.encode(SquadCodec.domain(3), _context(matchId), summary.rulesetId, next)
        );
        summary.outcome = next.outcome;
        summary.reason = next.reason;
        summary.activeRound = next.outcome == 0 ? next.completedRound + 1 : next.completedRound;
        emit ISquadEvents.RoundResolved(
            matchId, round, beforeHash, summary.stateHash, next, effects
        );
        if (next.outcome == 0) {
            delete matchData.turn;
            delete matchData.revealedActions;
            Protocol.advance(
                summary,
                matchId,
                Protocol.ROUND_COMMIT,
                Protocol.deadlineAfter(Parameters.windows()[3])
            );
        } else {
            Protocol.advance(summary, matchId, Protocol.FINISHED, 0);
            address winner = address(0);
            if (next.outcome == 1) winner = summary.players[0];
            else if (next.outcome == 2) winner = summary.players[1];
            emit ISquadEvents.MatchFinished(
                matchId,
                round,
                winner,
                next.battleStarted,
                next.completedRound,
                next.outcome,
                next.reason,
                summary.stateHash
            );
        }
    }

    function _submission(SquadCodec.MatchSummary storage summary, uint16 round, uint8 phase)
        private
        view
        returns (uint8 side)
    {
        Protocol.requirePhase(summary, phase);
        _requireRound(summary, round);
        side = Protocol.playerIndex(summary);
        Protocol.requireTimely(summary.phaseDeadline);
    }

    function _requireRound(SquadCodec.MatchSummary storage summary, uint16 round) private view {
        if (round != summary.activeRound) revert Protocol.StaleRound(summary.activeRound, round);
    }

    function _context(uint256 matchId) private view returns (SquadCodec.Context memory) {
        return SquadCodec.Context(block.chainid, address(this), matchId);
    }

    function _pack(SquadCodec.Action[3] calldata actions) private pure returns (uint256 packed) {
        for (uint256 slot = 0; slot < Parameters.SQUAD_SIZE; ++slot) {
            SquadCodec.Action calldata action = actions[slot];
            uint256 value = uint256(action.actionType) | (uint256(action.targetCell) << BYTE_BITS)
                | (uint256(action.targetUnit) << (2 * BYTE_BITS))
                | (uint256(action.pathLength) << (3 * BYTE_BITS))
                | (uint256(action.pathBits) << (4 * BYTE_BITS));
            packed |= value << (slot * ACTION_BITS);
        }
    }

    // Each narrowed field is masked to its frozen width; only validated actions are stored.
    // forge-lint: disable-next-item(unsafe-typecast)
    function _unpack(uint256 packed) private pure returns (SquadCodec.Action[3] memory actions) {
        for (uint256 slot = 0; slot < Parameters.SQUAD_SIZE; ++slot) {
            uint256 value = packed >> (slot * ACTION_BITS);
            actions[slot] = SquadCodec.Action(
                uint8(value & type(uint8).max),
                uint8((value >> BYTE_BITS) & type(uint8).max),
                uint8((value >> (2 * BYTE_BITS)) & type(uint8).max),
                uint8((value >> (3 * BYTE_BITS)) & type(uint8).max),
                uint32((value >> (4 * BYTE_BITS)) & type(uint32).max)
            );
        }
    }
}
// forge-lint: disable-end(literal-instead-of-constant)
