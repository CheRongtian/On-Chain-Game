// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "./GameTypes.sol";

interface IArena {
    error UnknownMatch(uint256 matchId);
    error UnknownMap(uint8 mapId);
    error InvalidCoordinates(uint8 x, uint8 y);
    error InvalidCell(uint8 cell);
    error NotPlayer(address caller);
    error NotCreator(address caller);
    error SelfJoin();
    error InvalidPhase(GameTypes.Phase expected, GameTypes.Phase actual);
    error InvalidTimeoutPhase(GameTypes.Phase phase);
    error InvalidRound(uint8 round);
    error StaleRound(uint8 expected, uint8 actual);
    error DeadlinePassed(uint64 deadline);
    error DeadlineNotPassed(uint64 deadline);
    error AlreadyCommitted(address player);
    error AlreadyRevealed(address player);
    error CommitmentMismatch();
    error BattleNotStarted(uint256 matchId);
    error InvalidActionEncoding(uint8 slot);
    error InvalidUnitState(uint8 unitId);
    error InvalidPlayerState(uint8 playerIndex);
    error InvalidBattleResult();
    error InvalidAction(uint8 unitId);
    error InvalidPath(uint8 unitId);
    error InvalidTarget(uint8 unitId);
    error InsufficientEnergy(uint8 playerIndex, uint8 required, uint8 available);

    event MatchCreated(
        uint256 indexed matchId,
        address indexed creator,
        uint8 mapId,
        bytes32 rulesHash,
        uint64 joinDeadline
    );

    event PlayerJoined(uint256 indexed matchId, address indexed player);

    event MatchStarted(
        uint256 indexed matchId, GameTypes.BattleState initialState, bytes32 stateHash
    );

    event ActionCommitted(
        uint256 indexed matchId,
        uint8 indexed round,
        address indexed player,
        bytes32 commitment
    );

    event ActionRevealed(
        uint256 indexed matchId,
        uint8 indexed round,
        address indexed player,
        GameTypes.Action[3] actions,
        bytes32 salt
    );

    // Emitted for every phase change, including waiting-room cancellation and expiry.
    // deadline is joinDeadline while waiting, phaseDeadline in Commit/Reveal, otherwise zero.
    event PhaseAdvanced(
        uint256 indexed matchId,
        uint8 indexed round,
        GameTypes.Phase phase,
        uint64 deadline
    );

    // round identifies the settled round.
    // afterStateHash includes the next round if play continues.
    event RoundResolved(
        uint256 indexed matchId,
        uint8 indexed round,
        bytes32 beforeStateHash,
        bytes32 afterStateHash,
        GameTypes.PlayerState[2] players,
        GameTypes.Outcome outcome,
        GameTypes.EndReason reason
    );

    // winner is address(0) for a draw. Timeout termination emits no RoundResolved event.
    event MatchFinished(
        uint256 indexed matchId,
        uint8 round,
        address indexed winner,
        GameTypes.Outcome outcome,
        GameTypes.EndReason reason,
        bytes32 stateHash
    );

    // Match IDs start at 1. Creation enters WaitingForOpponent with round/stateHash zero.
    function createMatch(uint8 mapId) external returns (uint256 matchId);

    // A different player joins at or before joinDeadline, initializing all six slots and round 1.
    function joinMatch(uint256 matchId) external;

    // The creator may cancel while waiting, including after the deadline until expiry executes.
    function cancelUnjoinedMatch(uint256 matchId) external;

    // Anyone may expire a waiting room strictly after joinDeadline.
    function expireUnjoinedMatch(uint256 matchId) external;

    // Only a player may submit once in Commit, at or before the phase deadline.
    // Implementations bind hash context to block.chainid, address(this), and msg.sender.
    function commitActions(uint256 matchId, uint8 round, bytes32 commitment) external;

    // Reveal requires the original commitment, canonical orders, and an unexpired Reveal phase.
    // Orders must match round-start units and Energy; dead slots require Hold.
    function revealActions(
        uint256 matchId, uint8 round, GameTypes.Action[3] calldata actions, bytes32 salt
    ) external;

    // Anyone may settle Resolvable once; the requested round must still be current.
    function settleRound(uint256 matchId, uint8 round) external;

    // Anyone may finalize strictly after phaseDeadline in Commit or Reveal.
    // expectedPhase and round must still match; one missing submission forfeits, both draw.
    function advanceExpiredPhase(
        uint256 matchId, uint8 round, GameTypes.Phase expectedPhase
    ) external;

    function getRules() external view returns (GameTypes.Rules memory);

    function getRulesHash() external view returns (bytes32);

    function getMap(uint8 mapId) external view returns (GameTypes.MapConfig memory);

    function getMatch(uint256 matchId) external view returns (GameTypes.MatchSummary memory);

    // Battle getters reject rooms that have never been joined.
    function getBattleState(uint256 matchId) external view returns (GameTypes.BattleState memory);

    function getRoundStatus(uint256 matchId) external view returns (GameTypes.RoundStatus memory);
}
