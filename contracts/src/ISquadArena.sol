// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "./SquadCodec.sol";

// The event-only interface is also shared by the offline emitter.
// forge-lint: disable-start(multi-contract-file)

interface ISquadEvents {
    event MatchCreated(
        uint256 indexed matchId,
        address indexed creator,
        bytes32 rulesetId,
        uint8 mapId,
        bytes32 mapHash,
        uint64 joinDeadline
    );
    event PlayerJoined(
        uint256 indexed matchId, address indexed player, uint8 phase, uint64 joinDeadline
    );
    event SquadCommitted(uint256 indexed matchId, address indexed player, bytes32 commitment);
    event SquadRevealed(
        uint256 indexed matchId, address indexed player, uint8[3] unitTypes, bytes32 salt
    );
    event GameStarted(uint256 indexed matchId, SquadCodec.State initialState, bytes32 stateHash);
    event ActionCommitted(
        uint256 indexed matchId, uint16 indexed round, address indexed player, bytes32 commitment
    );
    event ActionRevealed(
        uint256 indexed matchId,
        uint16 indexed round,
        address indexed player,
        SquadCodec.Action[3] actions,
        bytes32 salt
    );
    event PhaseAdvanced(
        uint256 indexed matchId,
        uint16 indexed round,
        uint8 fromPhase,
        uint8 toPhase,
        uint64 deadline
    );
    event RoundResolved(
        uint256 indexed matchId,
        uint16 indexed round,
        bytes32 beforeStateHash,
        bytes32 afterStateHash,
        SquadCodec.State state,
        SquadCodec.Effects effects
    );
    event MatchFinished(
        uint256 indexed matchId,
        uint16 round,
        address indexed winner,
        bool battleStarted,
        uint16 completedRound,
        uint8 outcome,
        uint8 reason,
        bytes32 stateHash
    );
}

interface ISquadArena is ISquadEvents {
    function createMatch(uint8 mapId) external returns (uint256 matchId);
    function joinMatch(uint256 matchId) external;
    function startMatch(uint256 matchId) external;
    function cancelWaitingMatch(uint256 matchId) external;
    function expireWaitingMatch(uint256 matchId) external;
    function commitSquad(uint256 matchId, bytes32 commitment) external;
    function revealSquad(uint256 matchId, uint8[3] calldata unitTypes, bytes32 salt) external;
    function commitActions(uint256 matchId, uint16 round, bytes32 commitment) external;
    function revealActions(
        uint256 matchId,
        uint16 round,
        SquadCodec.Action[3] calldata actions,
        bytes32 salt
    ) external;
    function settleRound(uint256 matchId, uint16 round) external;
    function advanceExpiredPhase(uint256 matchId, uint16 round, uint8 expectedPhase) external;
    function getRulesetId() external view returns (bytes32);
    function getSchemaVersions()
        external
        view
        returns (uint16 actionSchema, uint16 stateSchema, uint16 eventSchema);
    function getRules() external view returns (SquadCodec.Rules memory);
    function getMap(uint8 mapId) external view returns (SquadCodec.Map memory);
    function getMatch(uint256 matchId) external view returns (SquadCodec.MatchSummary memory);
    function getBattleState(uint256 matchId) external view returns (SquadCodec.State memory);
    function getSquadStatus(uint256 matchId) external view returns (SquadCodec.SquadStatus memory);
    function getRoundStatus(uint256 matchId) external view returns (SquadCodec.RoundStatus memory);
}
// forge-lint: disable-end(multi-contract-file)
