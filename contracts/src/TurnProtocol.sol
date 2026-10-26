// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "./GameTypes.sol";
import { GameHash } from "./GameHash.sol";
import { UnitRules } from "./UnitRules.sol";
import { IArena } from "./IArena.sol";

library TurnProtocol {
    uint256 private constant SQUAD_SIZE = 3;

    struct MatchData {
        GameTypes.MatchSummary summary;
        GameTypes.BattleState battle;
        GameTypes.RoundStatus roundStatus;
        GameTypes.Action[SQUAD_SIZE][2] revealedActions;
    }

    function commit(
        MatchData storage matchData, uint256 matchId, uint8 round, bytes32 commitment
    ) internal {
        uint8 player = _requireSubmission(matchData.summary, round, GameTypes.Phase.Commit);
        GameTypes.RoundStatus storage status = matchData.roundStatus;
        if (status.committed[player]) revert IArena.AlreadyCommitted(msg.sender);

        status.commitments[player] = commitment;
        status.committed[player] = true;
        emit IArena.ActionCommitted(matchId, round, msg.sender, commitment);
        if (status.committed[0] && status.committed[1]) {
            _advancePhase(
                matchData.summary, matchId, GameTypes.Phase.Reveal,
                deadlineAfter(GameTypes.PHASE_DURATION)
            );
        }
    }

    function reveal(
        MatchData storage matchData, uint256 matchId, uint8 round,
        GameTypes.Action[SQUAD_SIZE] calldata actions, bytes32 salt
    ) internal {
        uint8 player = _requireSubmission(matchData.summary, round, GameTypes.Phase.Reveal);
        GameTypes.RoundStatus storage status = matchData.roundStatus;
        if (status.revealed[player]) revert IArena.AlreadyRevealed(msg.sender);
        bytes32 commitment =
            GameHash.actionCommitment(_context(matchId), round, msg.sender, actions, salt);
        if (commitment != status.commitments[player]) revert IArena.CommitmentMismatch();
        UnitRules.validateActions(matchData.battle, player, actions);

        _storeActions(matchData.revealedActions[player], actions);
        status.revealed[player] = true;
        emit IArena.ActionRevealed(matchId, round, msg.sender, actions, salt);
        if (status.revealed[0] && status.revealed[1]) {
            _advancePhase(matchData.summary, matchId, GameTypes.Phase.Resolvable, 0);
        }
    }

    function expire(
        MatchData storage matchData, uint256 matchId, uint8 round,
        GameTypes.Phase expectedPhase
    ) internal {
        GameTypes.MatchSummary storage summary = matchData.summary;
        _requireTimeout(summary, round, expectedPhase);
        GameTypes.Outcome outcome = _timeoutOutcome(matchData.roundStatus, expectedPhase);
        GameTypes.EndReason reason = expectedPhase == GameTypes.Phase.Commit
            ? GameTypes.EndReason.CommitTimeout : GameTypes.EndReason.RevealTimeout;

        matchData.battle.outcome = outcome;
        matchData.battle.reason = reason;
        summary.outcome = outcome;
        summary.reason = reason;
        summary.stateHash = GameHash.hashBattleState(_context(matchId), matchData.battle);
        _advancePhase(summary, matchId, GameTypes.Phase.Finished, 0);

        address winner = address(0);
        if (outcome == GameTypes.Outcome.PlayerA) winner = summary.players[0];
        else if (outcome == GameTypes.Outcome.PlayerB) winner = summary.players[1];
        emit IArena.MatchFinished(matchId, round, winner, outcome, reason, summary.stateHash);
    }

    function deadlineAfter(uint32 duration) internal view returns (uint64) {
        // Supported chain timestamps and protocol durations fit uint64 Unix seconds.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.timestamp + duration);
    }

    function _requireSubmission(
        GameTypes.MatchSummary storage summary, uint8 round, GameTypes.Phase expectedPhase
    ) private view returns (uint8 player) {
        _requirePhase(summary, expectedPhase);
        _requireRound(summary, round);
        player = _playerIndex(summary);
        // Submissions remain timely at the exact chain deadline.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > summary.phaseDeadline) {
            revert IArena.DeadlinePassed(summary.phaseDeadline);
        }
    }

    function _requireTimeout(
        GameTypes.MatchSummary storage summary, uint8 round, GameTypes.Phase expectedPhase
    ) private view {
        if (expectedPhase != GameTypes.Phase.Commit && expectedPhase != GameTypes.Phase.Reveal) {
            revert IArena.InvalidTimeoutPhase(expectedPhase);
        }
        _requirePhase(summary, expectedPhase);
        _requireRound(summary, round);
        // Public timeout progression requires a strictly later chain timestamp.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= summary.phaseDeadline) {
            revert IArena.DeadlineNotPassed(summary.phaseDeadline);
        }
    }

    function _requirePhase(GameTypes.MatchSummary storage summary, GameTypes.Phase expected)
        private
        view
    {
        if (summary.phase != expected) revert IArena.InvalidPhase(expected, summary.phase);
    }

    function _requireRound(GameTypes.MatchSummary storage summary, uint8 round) private view {
        if (round != summary.round) revert IArena.StaleRound(summary.round, round);
    }

    function _playerIndex(GameTypes.MatchSummary storage summary) private view returns (uint8) {
        if (msg.sender == summary.players[0]) return 0;
        if (msg.sender == summary.players[1]) return 1;
        revert IArena.NotPlayer(msg.sender);
    }

    function _timeoutOutcome(GameTypes.RoundStatus storage status, GameTypes.Phase phase)
        private
        view
        returns (GameTypes.Outcome)
    {
        bool submittedA = phase == GameTypes.Phase.Commit ? status.committed[0] : status.revealed[0];
        bool submittedB = phase == GameTypes.Phase.Commit ? status.committed[1] : status.revealed[1];
        if (submittedA == submittedB) return GameTypes.Outcome.Draw;
        return submittedA ? GameTypes.Outcome.PlayerA : GameTypes.Outcome.PlayerB;
    }

    function _storeActions(
        GameTypes.Action[SQUAD_SIZE] storage destination,
        GameTypes.Action[SQUAD_SIZE] calldata source
    ) private {
        for (uint256 slot = 0; slot < GameTypes.SQUAD_SIZE; ++slot) {
            destination[slot].kind = source[slot].kind;
            destination[slot].targetCell = source[slot].targetCell;
            destination[slot].pathLength = source[slot].pathLength;
            for (uint256 step = 0; step < GameTypes.MAX_PATH_LENGTH; ++step) {
                destination[slot].path[step] = source[slot].path[step];
            }
        }
    }

    function _advancePhase(
        GameTypes.MatchSummary storage summary, uint256 matchId, GameTypes.Phase phase,
        uint64 deadline
    ) private {
        summary.phase = phase;
        summary.phaseDeadline = deadline;
        emit IArena.PhaseAdvanced(matchId, summary.round, phase, deadline);
    }

    function _context(uint256 matchId) private view returns (GameTypes.MatchContext memory) {
        return GameTypes.MatchContext({
            chainId: block.chainid, arena: address(this), matchId: matchId
        });
    }
}
