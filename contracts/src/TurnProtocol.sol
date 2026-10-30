// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "./GameTypes.sol";
import { GameHash } from "./GameHash.sol";
import { UnitRules } from "./UnitRules.sol";
import { BattleResolver } from "./BattleResolver.sol";
import { IArena } from "./IArena.sol";

library TurnProtocol {
    uint256 private constant SQUAD_SIZE = 3;
    uint256 private constant BYTE_BITS = 8;
    uint256 private constant ACTION_HEADER_BYTES = 3;
    uint256 private constant ACTION_BITS = 56;

    struct MatchData {
        GameTypes.MatchSummary summary;
        GameTypes.BattleState battle;
        GameTypes.RoundStatus roundStatus;
        // Each validated three-action bundle occupies 21 bytes in one storage word.
        uint256[2] revealedActions;
    }

    function commit(MatchData storage matchData, uint256 matchId, uint8 round, bytes32 commitment)
        internal
    {
        uint8 player = _requireSubmission(matchData.summary, round, GameTypes.Phase.Commit);
        GameTypes.RoundStatus storage status = matchData.roundStatus;
        if (status.committed[player]) revert IArena.AlreadyCommitted(msg.sender);

        status.commitments[player] = commitment;
        status.committed[player] = true;
        emit IArena.ActionCommitted(matchId, round, msg.sender, commitment);
        if (status.committed[0] && status.committed[1]) {
            _advancePhase(
                matchData.summary,
                matchId,
                GameTypes.Phase.Reveal,
                deadlineAfter(GameTypes.PHASE_DURATION)
            );
        }
    }

    function reveal(
        MatchData storage matchData,
        uint256 matchId,
        uint8 round,
        GameTypes.Action[SQUAD_SIZE] calldata actions,
        bytes32 salt
    ) internal {
        uint8 player = _requireSubmission(matchData.summary, round, GameTypes.Phase.Reveal);
        GameTypes.RoundStatus storage status = matchData.roundStatus;
        if (status.revealed[player]) revert IArena.AlreadyRevealed(msg.sender);
        bytes32 commitment =
            GameHash.actionCommitment(_context(matchId), round, msg.sender, actions, salt);
        if (commitment != status.commitments[player]) revert IArena.CommitmentMismatch();
        UnitRules.validateActions(matchData.battle, player, actions);

        matchData.revealedActions[player] = _packActions(actions);
        status.revealed[player] = true;
        emit IArena.ActionRevealed(matchId, round, msg.sender, actions, salt);
        if (status.revealed[0] && status.revealed[1]) {
            _advancePhase(matchData.summary, matchId, GameTypes.Phase.Resolvable, 0);
        }
    }

    function settle(MatchData storage matchData, uint256 matchId, uint8 round) internal {
        GameTypes.MatchSummary storage summary = matchData.summary;
        _requirePhase(summary, GameTypes.Phase.Resolvable);
        _requireRound(summary, round);
        bytes32 beforeHash = summary.stateHash;
        (GameTypes.BattleState memory next,) = BattleResolver.resolve(
            matchData.battle,
            _unpackActions(matchData.revealedActions[0]),
            _unpackActions(matchData.revealedActions[1])
        );
        storeBattle(matchData.battle, next);
        summary.round = next.round;
        summary.outcome = next.outcome;
        summary.reason = next.reason;
        summary.stateHash = GameHash.hashBattleState(_context(matchId), next);
        emit IArena.RoundResolved(
            matchId, round, beforeHash, summary.stateHash, next.players, next.outcome, next.reason
        );

        if (next.outcome == GameTypes.Outcome.None) {
            delete matchData.roundStatus;
            delete matchData.revealedActions;
            _advancePhase(
                summary, matchId, GameTypes.Phase.Commit, deadlineAfter(GameTypes.PHASE_DURATION)
            );
        } else {
            _finishMatch(summary, matchId);
        }
    }

    function expire(
        MatchData storage matchData,
        uint256 matchId,
        uint8 round,
        GameTypes.Phase expectedPhase
    ) internal {
        GameTypes.MatchSummary storage summary = matchData.summary;
        _requireTimeout(summary, round, expectedPhase);
        GameTypes.Outcome outcome = _timeoutOutcome(matchData.roundStatus, expectedPhase);
        GameTypes.EndReason reason = expectedPhase == GameTypes.Phase.Commit
            ? GameTypes.EndReason.CommitTimeout
            : GameTypes.EndReason.RevealTimeout;

        matchData.battle.outcome = outcome;
        matchData.battle.reason = reason;
        summary.outcome = outcome;
        summary.reason = reason;
        summary.stateHash = GameHash.hashBattleState(_context(matchId), matchData.battle);
        _finishMatch(summary, matchId);
    }

    function storeBattle(
        GameTypes.BattleState storage destination,
        GameTypes.BattleState memory source
    ) internal {
        destination.mapId = source.mapId;
        destination.round = source.round;
        for (uint256 player = 0; player < source.players.length; ++player) {
            destination.players[player].energy = source.players[player].energy;
            destination.players[player].victoryPoints = source.players[player].victoryPoints;
        }
        for (uint256 slot = 0; slot < GameTypes.UNIT_COUNT; ++slot) {
            destination.units[slot].unitType = source.units[slot].unitType;
            destination.units[slot].cell = source.units[slot].cell;
            destination.units[slot].hp = source.units[slot].hp;
        }
        destination.outcome = source.outcome;
        destination.reason = source.reason;
    }

    function deadlineAfter(uint32 duration) internal view returns (uint64) {
        // Supported chain timestamps and protocol durations fit uint64 Unix seconds.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.timestamp + duration);
    }

    function _requireSubmission(
        GameTypes.MatchSummary storage summary,
        uint8 round,
        GameTypes.Phase expectedPhase
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
        GameTypes.MatchSummary storage summary,
        uint8 round,
        GameTypes.Phase expectedPhase
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

    function _packActions(GameTypes.Action[SQUAD_SIZE] calldata source)
        private
        pure
        returns (uint256 packed)
    {
        for (uint256 slot = 0; slot < SQUAD_SIZE; ++slot) {
            GameTypes.Action calldata action = source[slot];
            uint256 value = uint256(action.kind) | (uint256(action.targetCell) << BYTE_BITS)
                | (uint256(action.pathLength) << (2 * BYTE_BITS));
            for (uint256 step = 0; step < GameTypes.MAX_PATH_LENGTH; ++step) {
                value |= uint256(action.path[step]) << ((ACTION_HEADER_BYTES + step) * BYTE_BITS);
            }
            packed |= value << (slot * ACTION_BITS);
        }
    }

    // Every narrowed field is masked to one byte; only validated actions reach this storage.
    // forge-lint: disable-next-item(unsafe-typecast)
    function _unpackActions(uint256 packed)
        private
        pure
        returns (GameTypes.Action[SQUAD_SIZE] memory actions)
    {
        for (uint256 slot = 0; slot < SQUAD_SIZE; ++slot) {
            uint256 value = packed >> (slot * ACTION_BITS);
            actions[slot].kind = GameTypes.ActionKind(value & type(uint8).max);
            actions[slot].targetCell = uint8((value >> BYTE_BITS) & type(uint8).max);
            actions[slot].pathLength = uint8((value >> (2 * BYTE_BITS)) & type(uint8).max);
            for (uint256 step = 0; step < GameTypes.MAX_PATH_LENGTH; ++step) {
                actions[slot].path[step] =
                    uint8((value >> ((ACTION_HEADER_BYTES + step) * BYTE_BITS)) & type(uint8).max);
            }
        }
    }

    function _finishMatch(GameTypes.MatchSummary storage summary, uint256 matchId) private {
        _advancePhase(summary, matchId, GameTypes.Phase.Finished, 0);
        address winner = address(0);
        if (summary.outcome == GameTypes.Outcome.PlayerA) winner = summary.players[0];
        else if (summary.outcome == GameTypes.Outcome.PlayerB) winner = summary.players[1];
        emit IArena.MatchFinished(
            matchId, summary.round, winner, summary.outcome, summary.reason, summary.stateHash
        );
    }

    function _advancePhase(
        GameTypes.MatchSummary storage summary,
        uint256 matchId,
        GameTypes.Phase phase,
        uint64 deadline
    ) private {
        summary.phase = phase;
        summary.phaseDeadline = deadline;
        emit IArena.PhaseAdvanced(matchId, summary.round, phase, deadline);
    }

    function _context(uint256 matchId) private view returns (GameTypes.MatchContext memory) {
        return
            GameTypes.MatchContext({
                chainId: block.chainid, arena: address(this), matchId: matchId
            });
    }
}
