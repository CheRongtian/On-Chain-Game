// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "./GameTypes.sol";
import { GameHash } from "./GameHash.sol";
import { IArena } from "./IArena.sol";

contract Arena {
    struct MatchData {
        GameTypes.MatchSummary summary;
        GameTypes.BattleState battle;
        GameTypes.RoundStatus roundStatus;
    }

    bytes32 private immutable RULES_HASH;
    uint256 private _nextMatchId = 1;
    mapping(uint256 => MatchData) private _matches;

    constructor() {
        RULES_HASH = GameHash.rulesHash();
    }

    function createMatch(uint8 mapId) external returns (uint256 matchId) {
        _requireMap(mapId);
        matchId = _nextMatchId++;
        GameTypes.MatchSummary storage summary = _matches[matchId].summary;
        summary.players[0] = msg.sender;
        summary.mapId = mapId;
        summary.rulesHash = RULES_HASH;
        summary.phase = GameTypes.Phase.WaitingForOpponent;
        summary.joinDeadline = _deadlineAfter(GameTypes.ROOM_LIFETIME);

        emit IArena.MatchCreated(matchId, msg.sender, mapId, RULES_HASH, summary.joinDeadline);
        emit IArena.PhaseAdvanced(
            matchId, 0, GameTypes.Phase.WaitingForOpponent, summary.joinDeadline
        );
    }

    function joinMatch(uint256 matchId) external {
        MatchData storage matchData = _requireMatch(matchId);
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
        GameTypes.BattleState storage battle = matchData.battle;
        battle.mapId = initialState.mapId;
        battle.round = initialState.round;
        for (uint256 player = 0; player < initialState.players.length; ++player) {
            battle.players[player].energy = initialState.players[player].energy;
            battle.players[player].victoryPoints = initialState.players[player].victoryPoints;
        }
        for (uint256 slot = 0; slot < GameTypes.UNIT_COUNT; ++slot) {
            battle.units[slot].unitType = initialState.units[slot].unitType;
            battle.units[slot].cell = initialState.units[slot].cell;
            battle.units[slot].hp = initialState.units[slot].hp;
        }
        battle.outcome = initialState.outcome;
        battle.reason = initialState.reason;
        summary.players[1] = msg.sender;
        summary.phase = GameTypes.Phase.Commit;
        summary.round = initialState.round;
        summary.phaseDeadline = _deadlineAfter(GameTypes.PHASE_DURATION);
        summary.stateHash = GameHash.hashBattleState(context, initialState);

        emit IArena.PlayerJoined(matchId, msg.sender);
        emit IArena.MatchStarted(matchId, initialState, summary.stateHash);
        emit IArena.PhaseAdvanced(
            matchId, summary.round, GameTypes.Phase.Commit, summary.phaseDeadline
        );
    }

    function cancelUnjoinedMatch(uint256 matchId) external {
        GameTypes.MatchSummary storage summary = _requireMatch(matchId).summary;
        _requireWaiting(summary);
        if (msg.sender != summary.players[0]) revert IArena.NotCreator(msg.sender);

        summary.phase = GameTypes.Phase.Cancelled;
        emit IArena.PhaseAdvanced(matchId, 0, GameTypes.Phase.Cancelled, 0);
    }

    function expireUnjoinedMatch(uint256 matchId) external {
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

    function getRules() external pure returns (GameTypes.Rules memory) {
        return GameTypes.defaultRules();
    }

    function getRulesHash() external view returns (bytes32) {
        return RULES_HASH;
    }

    function getMap(uint8 mapId) external pure returns (GameTypes.MapConfig memory) {
        _requireMap(mapId);
        return GameTypes.defaultMap();
    }

    function getMatch(uint256 matchId) external view returns (GameTypes.MatchSummary memory) {
        return _requireMatch(matchId).summary;
    }

    function getBattleState(uint256 matchId) external view returns (GameTypes.BattleState memory) {
        return _requireStartedMatch(matchId).battle;
    }

    function getRoundStatus(uint256 matchId) external view returns (GameTypes.RoundStatus memory) {
        return _requireStartedMatch(matchId).roundStatus;
    }

    function _requireMatch(uint256 matchId) private view returns (MatchData storage matchData) {
        matchData = _matches[matchId];
        if (matchData.summary.players[0] == address(0)) revert IArena.UnknownMatch(matchId);
    }

    function _requireStartedMatch(uint256 matchId)
        private
        view
        returns (MatchData storage matchData)
    {
        matchData = _requireMatch(matchId);
        if (matchData.summary.players[1] == address(0)) revert IArena.BattleNotStarted(matchId);
    }

    function _requireWaiting(GameTypes.MatchSummary storage summary) private view {
        if (summary.phase != GameTypes.Phase.WaitingForOpponent) {
            revert IArena.InvalidPhase(GameTypes.Phase.WaitingForOpponent, summary.phase);
        }
    }

    function _requireMap(uint8 mapId) private pure {
        if (mapId != GameTypes.MAP_ID) revert IArena.UnknownMap(mapId);
    }

    function _deadlineAfter(uint32 duration) private view returns (uint64) {
        // Supported chain timestamps and protocol durations fit uint64 Unix seconds.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.timestamp + duration);
    }
}
