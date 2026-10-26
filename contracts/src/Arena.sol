// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "./GameTypes.sol";
import { GameHash } from "./GameHash.sol";
import { MapRules } from "./MapRules.sol";
import { TurnProtocol } from "./TurnProtocol.sol";
import { IArena } from "./IArena.sol";

contract Arena is IArena {
    bytes32 private immutable RULES_HASH;
    uint256 private _nextMatchId = 1;
    mapping(uint256 => TurnProtocol.MatchData) private _matches;

    constructor() {
        RULES_HASH = GameHash.rulesHash();
    }

    function createMatch(uint8 mapId) external override returns (uint256 matchId) {
        MapRules.requireKnownMap(mapId);
        matchId = _nextMatchId++;
        GameTypes.MatchSummary storage summary = _matches[matchId].summary;
        summary.players[0] = msg.sender;
        summary.mapId = mapId;
        summary.rulesHash = RULES_HASH;
        summary.phase = GameTypes.Phase.WaitingForOpponent;
        summary.joinDeadline = TurnProtocol.deadlineAfter(GameTypes.ROOM_LIFETIME);

        emit IArena.MatchCreated(matchId, msg.sender, mapId, RULES_HASH, summary.joinDeadline);
        emit IArena.PhaseAdvanced(
            matchId, 0, GameTypes.Phase.WaitingForOpponent, summary.joinDeadline
        );
    }

    function joinMatch(uint256 matchId) external override {
        TurnProtocol.MatchData storage matchData = _requireMatch(matchId);
        GameTypes.MatchSummary storage summary = matchData.summary;
        _requireWaiting(summary);
        if (msg.sender == summary.players[0]) revert IArena.SelfJoin();
        // Joining is allowed at the deadline, measured using the chain timestamp.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > summary.joinDeadline) {
            revert IArena.DeadlinePassed(summary.joinDeadline);
        }

        GameTypes.BattleState memory initialState = GameTypes.initialBattleState();
        GameTypes.MatchContext memory context = GameTypes.MatchContext({
            chainId: block.chainid, arena: address(this), matchId: matchId
        });
        TurnProtocol.storeBattle(matchData.battle, initialState);
        summary.players[1] = msg.sender;
        summary.phase = GameTypes.Phase.Commit;
        summary.round = initialState.round;
        summary.phaseDeadline = TurnProtocol.deadlineAfter(GameTypes.PHASE_DURATION);
        summary.stateHash = GameHash.hashBattleState(context, initialState);

        emit IArena.PlayerJoined(matchId, msg.sender);
        emit IArena.MatchStarted(matchId, initialState, summary.stateHash);
        emit IArena.PhaseAdvanced(
            matchId, summary.round, GameTypes.Phase.Commit, summary.phaseDeadline
        );
    }

    function cancelUnjoinedMatch(uint256 matchId) external override {
        GameTypes.MatchSummary storage summary = _requireMatch(matchId).summary;
        _requireWaiting(summary);
        if (msg.sender != summary.players[0]) revert IArena.NotCreator(msg.sender);

        summary.phase = GameTypes.Phase.Cancelled;
        emit IArena.PhaseAdvanced(matchId, 0, GameTypes.Phase.Cancelled, 0);
    }

    function expireUnjoinedMatch(uint256 matchId) external override {
        GameTypes.MatchSummary storage summary = _requireMatch(matchId).summary;
        _requireWaiting(summary);
        // Expiry requires the chain timestamp to pass the room deadline.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= summary.joinDeadline) {
            revert IArena.DeadlineNotPassed(summary.joinDeadline);
        }

        summary.phase = GameTypes.Phase.Expired;
        emit IArena.PhaseAdvanced(matchId, 0, GameTypes.Phase.Expired, 0);
    }

    function commitActions(uint256 matchId, uint8 round, bytes32 commitment) external override {
        TurnProtocol.commit(_requireMatch(matchId), matchId, round, commitment);
    }

    function revealActions(
        uint256 matchId,
        uint8 round,
        GameTypes.Action[3] calldata actions,
        bytes32 salt
    ) external override {
        TurnProtocol.reveal(_requireMatch(matchId), matchId, round, actions, salt);
    }

    function settleRound(uint256 matchId, uint8 round) external override {
        TurnProtocol.settle(_requireMatch(matchId), matchId, round);
    }

    function advanceExpiredPhase(uint256 matchId, uint8 round, GameTypes.Phase expectedPhase)
        external
        override
    {
        TurnProtocol.expire(_requireMatch(matchId), matchId, round, expectedPhase);
    }

    function getRules() external pure override returns (GameTypes.Rules memory) {
        return GameTypes.defaultRules();
    }

    function getRulesHash() external view override returns (bytes32) {
        return RULES_HASH;
    }

    function getMap(uint8 mapId) external pure override returns (GameTypes.MapConfig memory) {
        return MapRules.getMap(mapId);
    }

    function getMatch(uint256 matchId)
        external
        view
        override
        returns (GameTypes.MatchSummary memory)
    {
        return _requireMatch(matchId).summary;
    }

    function getBattleState(uint256 matchId)
        external
        view
        override
        returns (GameTypes.BattleState memory)
    {
        return _requireStartedMatch(matchId).battle;
    }

    function getRoundStatus(uint256 matchId)
        external
        view
        override
        returns (GameTypes.RoundStatus memory)
    {
        return _requireStartedMatch(matchId).roundStatus;
    }

    function _requireMatch(uint256 matchId)
        private
        view
        returns (TurnProtocol.MatchData storage matchData)
    {
        matchData = _matches[matchId];
        if (matchData.summary.players[0] == address(0)) revert IArena.UnknownMatch(matchId);
    }

    function _requireStartedMatch(uint256 matchId)
        private
        view
        returns (TurnProtocol.MatchData storage matchData)
    {
        matchData = _requireMatch(matchId);
        if (matchData.summary.players[1] == address(0)) revert IArena.BattleNotStarted(matchId);
    }

    function _requireWaiting(GameTypes.MatchSummary storage summary) private view {
        if (summary.phase != GameTypes.Phase.WaitingForOpponent) {
            revert IArena.InvalidPhase(GameTypes.Phase.WaitingForOpponent, summary.phase);
        }
    }
}
