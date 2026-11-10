// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "./SquadCodec.sol";
import { SquadParameters as Parameters } from "./SquadParameters.sol";
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

    uint8 internal constant WAITING = 1;
    uint8 internal constant SQUAD_COMMIT = 2;
    uint8 internal constant SQUAD_REVEAL = 3;

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
        uint8 side;
        if (msg.sender == summary.players[0]) side = 0;
        else if (msg.sender == summary.players[1]) side = 1;
        else revert NotPlayer(msg.sender);
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

    function requirePhase(SquadCodec.MatchSummary storage summary, uint8 expected) internal view {
        if (summary.phase != expected) revert InvalidPhase(expected, summary.phase);
    }

    function requireTimely(uint64 deadline) internal view {
        // A submission at the exact chain deadline remains valid.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert DeadlinePassed(deadline);
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
    ) private {
        uint8 previous = summary.phase;
        summary.phase = next;
        summary.phaseDeadline = deadline;
        emit ISquadEvents.PhaseAdvanced(matchId, summary.activeRound, previous, next, deadline);
    }
}
