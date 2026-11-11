// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "./SquadCodec.sol";
import { SquadParameters as Parameters } from "./SquadParameters.sol";
import { SquadRules } from "./SquadRules.sol";
import { SquadProtocol } from "./SquadProtocol.sol";
import { SquadTurns } from "./SquadTurns.sol";
import { ISquadEvents } from "./ISquadArena.sol";

contract SquadArena is ISquadEvents {
    bytes32 private immutable RULESET_ID;
    uint256 private _nextMatchId = 1;
    mapping(uint256 => SquadCodec.MatchData) private _matches;

    constructor() {
        RULESET_ID = SquadRules.rulesetId();
    }

    function createMatch(uint8 mapId) external returns (uint256 matchId) {
        if (mapId == 0 || mapId > Parameters.MAP_COUNT) revert SquadProtocol.UnknownMap(mapId);
        SquadCodec.Map memory map = SquadRules.getMap(mapId);
        matchId = _nextMatchId++;
        SquadCodec.MatchData storage matchData = _matches[matchId];
        SquadCodec.MatchSummary storage summary = matchData.summary;
        summary.players[0] = msg.sender;
        summary.mapId = mapId;
        summary.mapHash = map.mapHash;
        summary.rulesetId = RULESET_ID;
        summary.phase = SquadProtocol.WAITING;
        summary.joinDeadline = SquadProtocol.deadlineAfter(Parameters.windows()[0]);
        matchData.battle.mapId = mapId;
        for (uint256 id = 0; id < Parameters.UNIT_COUNT; ++id) {
            matchData.battle.units[id].position = Parameters.UNUSED_CELL;
        }
        emit ISquadEvents.MatchCreated(
            matchId, msg.sender, RULESET_ID, mapId, map.mapHash, summary.joinDeadline
        );
        emit ISquadEvents.PhaseAdvanced(matchId, 0, 0, SquadProtocol.WAITING, summary.joinDeadline);
    }

    function joinMatch(uint256 matchId) external {
        SquadProtocol.join(_requireMatch(matchId).summary, matchId);
    }

    function startMatch(uint256 matchId) external {
        SquadProtocol.start(_requireMatch(matchId).summary, matchId);
    }

    function commitSquad(uint256 matchId, bytes32 commitment) external {
        SquadProtocol.commit(_requireMatch(matchId), matchId, commitment);
    }

    function revealSquad(uint256 matchId, uint8[3] calldata unitTypes, bytes32 salt) external {
        SquadProtocol.reveal(_requireMatch(matchId), matchId, unitTypes, salt);
    }

    function commitActions(uint256 matchId, uint16 round, bytes32 commitment) external {
        SquadTurns.commit(_requireMatch(matchId), matchId, round, commitment);
    }

    function revealActions(
        uint256 matchId,
        uint16 round,
        SquadCodec.Action[3] calldata actions,
        bytes32 salt
    ) external {
        SquadTurns.reveal(_requireMatch(matchId), matchId, round, actions, salt);
    }

    function settleRound(uint256 matchId, uint16 round) external {
        SquadTurns.settle(_requireMatch(matchId), matchId, round);
    }

    function getRulesetId() external view returns (bytes32) {
        return RULESET_ID;
    }

    function getSchemaVersions()
        external
        pure
        returns (uint16 actionSchema, uint16 stateSchema, uint16 eventSchema)
    {
        uint16[3] memory schemas = Parameters.schemas();
        return (schemas[0], schemas[1], schemas[2]);
    }

    function getRules() external pure returns (SquadCodec.Rules memory) {
        return SquadRules.getRules();
    }

    function getMap(uint8 mapId) external pure returns (SquadCodec.Map memory) {
        if (mapId == 0 || mapId > Parameters.MAP_COUNT) revert SquadProtocol.UnknownMap(mapId);
        return SquadRules.getMap(mapId);
    }

    function getMatch(uint256 matchId) external view returns (SquadCodec.MatchSummary memory) {
        return _requireMatch(matchId).summary;
    }

    function getBattleState(uint256 matchId) external view returns (SquadCodec.State memory) {
        return _requireMatch(matchId).battle;
    }

    function getSquadStatus(uint256 matchId) external view returns (SquadCodec.SquadStatus memory) {
        return _requireMatch(matchId).squad;
    }

    function getRoundStatus(uint256 matchId) external view returns (SquadCodec.RoundStatus memory) {
        return _requireMatch(matchId).turn;
    }

    function _requireMatch(uint256 matchId)
        private
        view
        returns (SquadCodec.MatchData storage matchData)
    {
        matchData = _matches[matchId];
        if (matchData.summary.players[0] == address(0)) revert SquadProtocol.UnknownMatch(matchId);
    }
}
