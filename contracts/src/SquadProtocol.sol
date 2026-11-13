// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "./SquadCodec.sol";
import { SquadParameters as Parameters } from "./SquadParameters.sol";
import { SquadRules } from "./SquadRules.sol";
import { ISquadEvents } from "./ISquadArena.sol";

library SquadProtocol {
    error UnknownMatch(uint256 matchId);
    error UnknownMap(uint8 mapId);
    error NotPlayer(address caller);
    error NotCreator(address caller);
    error SelfJoin();
    error RoomFull();
    error OpponentMissing();
    error InvalidPhase(uint8 expected, uint8 actual);
    error DeadlinePassed(uint64 deadline);
    error AlreadyCommitted(address player);
    error AlreadyRevealed(address player);
    error CommitmentMismatch();
    error StaleRound(uint16 expected, uint16 actual);
    error DeadlineNotPassed(uint64 deadline);
    error InvalidTimeoutPhase(uint8 phase);

    uint8 internal constant WAITING = 1;
    uint8 internal constant SQUAD_COMMIT = 2;
    uint8 internal constant SQUAD_REVEAL = 3;
    uint8 internal constant ROUND_COMMIT = 4;
    uint8 internal constant ROUND_REVEAL = 5;
    uint8 internal constant RESOLVABLE = 6;
    uint8 internal constant FINISHED = 7;
    uint8 internal constant CANCELLED = 8;
    uint8 internal constant EXPIRED = 9;

    function join(SquadCodec.MatchSummary storage summary, uint256 matchId) internal {
        requirePhase(summary, WAITING);
        if (msg.sender == summary.players[0]) revert SelfJoin();
        if (summary.players[1] != address(0)) revert RoomFull();
        requireTimely(summary.joinDeadline);
        summary.players[1] = msg.sender;
        emit ISquadEvents.PlayerJoined(matchId, msg.sender, summary.phase, summary.joinDeadline);
    }

    function start(SquadCodec.MatchSummary storage summary, uint256 matchId) internal {
        requirePhase(summary, WAITING);
        if (msg.sender != summary.players[0]) revert NotCreator(msg.sender);
        if (summary.players[1] == address(0)) revert OpponentMissing();
        requireTimely(summary.joinDeadline);
        advance(summary, matchId, SQUAD_COMMIT, deadlineAfter(Parameters.windows()[1]));
    }

    function commit(SquadCodec.MatchData storage matchData, uint256 matchId, bytes32 commitment)
        internal
    {
        SquadCodec.MatchSummary storage summary = matchData.summary;
        requirePhase(summary, SQUAD_COMMIT);
        uint8 side = playerIndex(summary);
        requireTimely(summary.phaseDeadline);
        SquadCodec.SquadStatus storage status = matchData.squad;
        if (status.committed[side]) revert AlreadyCommitted(msg.sender);
        status.commitments[side] = commitment;
        status.committed[side] = true;
        emit ISquadEvents.SquadCommitted(matchId, msg.sender, commitment);
        if (status.committed[0] && status.committed[1]) {
            advance(summary, matchId, SQUAD_REVEAL, deadlineAfter(Parameters.windows()[2]));
        }
    }

    function reveal(
        SquadCodec.MatchData storage matchData,
        uint256 matchId,
        uint8[3] memory unitTypes,
        bytes32 salt
    ) internal {
        SquadCodec.MatchSummary storage summary = matchData.summary;
        requirePhase(summary, SQUAD_REVEAL);
        uint8 side = playerIndex(summary);
        requireTimely(summary.phaseDeadline);
        SquadCodec.SquadStatus storage status = matchData.squad;
        if (status.revealed[side]) revert AlreadyRevealed(msg.sender);
        SquadCodec.Context memory context =
            SquadCodec.Context(block.chainid, address(this), matchId);
        bytes32 commitment = keccak256(
            SquadCodec.squadEncoding(
                SquadCodec.SquadInput(context, msg.sender, summary.rulesetId, unitTypes, salt)
            )
        );
        if (commitment != status.commitments[side]) revert CommitmentMismatch();
        status.unitTypes[side] = unitTypes;
        status.revealed[side] = true;
        emit ISquadEvents.SquadRevealed(matchId, msg.sender, unitTypes, salt);
        if (status.revealed[0] && status.revealed[1]) {
            SquadCodec.State memory initial =
                SquadRules.initialize(summary.mapId, status.unitTypes[0], status.unitTypes[1]);
            storeBattle(matchData.battle, initial);
            // The initializer validates both lineups; encode its canonical output with the bound ruleset.
            summary.stateHash =
                keccak256(abi.encode(SquadCodec.domain(3), context, summary.rulesetId, initial));
            summary.activeRound = 1;
            emit ISquadEvents.GameStarted(matchId, initial, summary.stateHash);
            advance(summary, matchId, ROUND_COMMIT, deadlineAfter(Parameters.windows()[3]));
        }
    }

    function playerIndex(SquadCodec.MatchSummary storage summary) internal view returns (uint8) {
        if (msg.sender == summary.players[0]) return 0;
        if (msg.sender == summary.players[1]) return 1;
        revert NotPlayer(msg.sender);
    }

    function storeBattle(SquadCodec.State storage target, SquadCodec.State memory source) internal {
        // Copy individual units to retain the frozen non-IR compiler pipeline.
        target.mapId = source.mapId;
        target.battleStarted = source.battleStarted;
        target.completedRound = source.completedRound;
        for (uint256 id = 0; id < Parameters.UNIT_COUNT; ++id) {
            target.units[id] = source.units[id];
        }
        target.energy = source.energy;
        target.victoryPoints = source.victoryPoints;
        target.outcome = source.outcome;
        target.reason = source.reason;
    }

    function requirePhase(SquadCodec.MatchSummary storage summary, uint8 expected) internal view {
        if (summary.phase != expected) revert InvalidPhase(expected, summary.phase);
    }

    function requireTimely(uint64 deadline) internal view {
        // A submission at the exact chain deadline remains valid.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert DeadlinePassed(deadline);
    }

    function requireExpired(uint64 deadline) internal view {
        // Expiry starts strictly after the inclusive submission deadline.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= deadline) revert DeadlineNotPassed(deadline);
    }

    function requireRound(SquadCodec.MatchSummary storage summary, uint16 round) internal view {
        if (round != summary.activeRound) revert StaleRound(summary.activeRound, round);
    }

    function finish(SquadCodec.MatchData storage matchData, uint256 matchId) internal {
        SquadCodec.MatchSummary storage summary = matchData.summary;
        advance(summary, matchId, FINISHED, 0);
        address winner = address(0);
        if (summary.outcome == 1) winner = summary.players[0];
        else if (summary.outcome == 2) winner = summary.players[1];
        emit ISquadEvents.MatchFinished(
            matchId,
            summary.activeRound,
            winner,
            matchData.battle.battleStarted,
            matchData.battle.completedRound,
            summary.outcome,
            summary.reason,
            summary.stateHash
        );
    }

    function deadlineAfter(uint32 duration) internal view returns (uint64) {
        // Supported local-chain timestamps and frozen durations fit uint64 Unix seconds.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.timestamp + duration);
    }

    function advance(
        SquadCodec.MatchSummary storage summary,
        uint256 matchId,
        uint8 next,
        uint64 deadline
    ) internal {
        uint8 previous = summary.phase;
        summary.phase = next;
        summary.phaseDeadline = deadline;
        emit ISquadEvents.PhaseAdvanced(matchId, summary.activeRound, previous, next, deadline);
    }
}
