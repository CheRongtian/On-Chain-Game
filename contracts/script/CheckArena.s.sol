// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { Arena } from "../src/Arena.sol";
import { GameTypes } from "../src/GameTypes.sol";
import { GameHash } from "../src/GameHash.sol";
import { IArena } from "../src/IArena.sol";
import { IDevVm } from "./IDevVm.sol";

// Checks the real local deployment, then exercises edge cases in a disposable fork.
contract CheckArena {
    IDevVm private constant VM = IDevVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address private constant PLAYER_A = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address private constant PLAYER_B = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    function run(address arenaAddress) external returns (uint256 matchId, bytes32 stateHash) {
        Arena arena = Arena(arenaAddress);
        matchId = 1;
        stateHash = _checkStartedMatch(arena, matchId);
        _checkUnknownInputs(arena);
        _checkCancellation(arena);
        _checkJoinDeadline(arena);
        _checkLateCancellation(arena);
        _checkExpiry(arena);
    }

    function _checkStartedMatch(Arena arena, uint256 matchId) private view returns (bytes32) {
        GameTypes.MatchSummary memory summary = arena.getMatch(matchId);
        require(
            summary.players[0] == PLAYER_A && summary.players[1] == PLAYER_B,
            "Joined players differ"
        );
        require(
            summary.phase == GameTypes.Phase.Commit && summary.round == 1,
            "Starting did not open the first Commit phase"
        );
        require(
            summary.mapId == GameTypes.MAP_ID && summary.rulesHash == GameHash.rulesHash()
                && summary.rulesHash == arena.getRulesHash(),
            "Match identity differs"
        );
        GameTypes.MatchContext memory context = GameTypes.MatchContext({
            chainId: block.chainid, arena: address(arena), matchId: matchId
        });
        bytes32 expectedHash = GameHash.hashBattleState(context, GameTypes.initialBattleState());
        require(
            summary.stateHash == expectedHash
                && GameHash.hashBattleState(context, arena.getBattleState(matchId)) == expectedHash,
            "Stored initial state or hash differs"
        );
        GameTypes.RoundStatus memory status = arena.getRoundStatus(matchId);
        require(
            !status.committed[0] && !status.committed[1] && !status.revealed[0]
                && !status.revealed[1] && status.commitments[0] == bytes32(0)
                && status.commitments[1] == bytes32(0),
            "Initial round submissions are not empty"
        );
        return expectedHash;
    }

    function _checkUnknownInputs(Arena arena) private {
        _expectRevert(
            arena,
            abi.encodeCall(Arena.getMatch, (0)),
            abi.encodeWithSelector(IArena.UnknownMatch.selector, 0)
        );
        VM.prank(PLAYER_A);
        _expectRevert(
            arena,
            abi.encodeCall(Arena.createMatch, (uint8(0))),
            abi.encodeWithSelector(IArena.UnknownMap.selector, uint8(0))
        );
        _expectRevert(
            arena,
            abi.encodeCall(Arena.getMap, (uint8(0))),
            abi.encodeWithSelector(IArena.UnknownMap.selector, uint8(0))
        );
        VM.prank(PLAYER_B);
        _expectRevert(
            arena,
            abi.encodeCall(Arena.joinMatch, (1)),
            abi.encodeWithSelector(
                IArena.InvalidPhase.selector, GameTypes.Phase.Lobby, GameTypes.Phase.Commit
            )
        );
    }

    function _createRoom(Arena arena) private returns (uint256 matchId) {
        VM.prank(PLAYER_A);
        matchId = arena.createMatch(GameTypes.MAP_ID);
        GameTypes.MatchSummary memory summary = arena.getMatch(matchId);
        require(
            summary.phase == GameTypes.Phase.Lobby && summary.players[0] == PLAYER_A
                && summary.players[1] == address(0),
            "Room creation differs"
        );
        require(
            summary.round == 0 && summary.stateHash == bytes32(0) && summary.phaseDeadline == 0
                && summary.outcome == GameTypes.Outcome.None
                && summary.reason == GameTypes.EndReason.None,
            "Waiting room has battle state"
        );
        require(
            summary.joinDeadline == VM.getBlockTimestamp() + GameTypes.ROOM_LIFETIME,
            "Room lifetime differs"
        );
    }

    function _checkCancellation(Arena arena) private {
        uint256 matchId = _createRoom(arena);
        _expectRevert(
            arena,
            abi.encodeCall(Arena.getBattleState, (matchId)),
            abi.encodeWithSelector(IArena.BattleNotStarted.selector, matchId)
        );
        _expectRevert(
            arena,
            abi.encodeCall(Arena.getRoundStatus, (matchId)),
            abi.encodeWithSelector(IArena.BattleNotStarted.selector, matchId)
        );
        VM.prank(PLAYER_A);
        _expectRevert(
            arena,
            abi.encodeCall(Arena.joinMatch, (matchId)),
            abi.encodeWithSelector(IArena.SelfJoin.selector)
        );
        VM.prank(PLAYER_B);
        _expectRevert(
            arena,
            abi.encodeCall(Arena.cancelWaitingMatch, (matchId)),
            abi.encodeWithSelector(IArena.NotCreator.selector, PLAYER_B)
        );
        VM.prank(PLAYER_A);
        arena.cancelWaitingMatch(matchId);
        _checkClosedRoom(arena, matchId, GameTypes.Phase.Cancelled);
    }

    function _checkJoinDeadline(Arena arena) private {
        uint256 matchId = _createRoom(arena);
        VM.warp(arena.getMatch(matchId).joinDeadline);
        VM.prank(PLAYER_B);
        arena.joinMatch(matchId);
        require(arena.getMatch(matchId).round == 0, "Joining started the battle");
        _expectRevert(
            arena,
            abi.encodeCall(Arena.getBattleState, (matchId)),
            abi.encodeWithSelector(IArena.BattleNotStarted.selector, matchId)
        );
        VM.prank(PLAYER_B);
        _expectRevert(
            arena,
            abi.encodeCall(Arena.startMatch, (matchId)),
            abi.encodeWithSelector(IArena.NotCreator.selector, PLAYER_B)
        );
        VM.prank(PLAYER_A);
        arena.startMatch(matchId);
        _checkStartedMatch(arena, matchId);
        require(
            arena.getMatch(matchId).phaseDeadline
                == VM.getBlockTimestamp() + GameTypes.PHASE_DURATION,
            "Initial Commit duration differs"
        );
    }

    function _checkLateCancellation(Arena arena) private {
        uint256 matchId = _createRoom(arena);
        uint64 deadline = arena.getMatch(matchId).joinDeadline;
        VM.warp(uint256(deadline) + 1);
        VM.prank(PLAYER_B);
        _expectRevert(
            arena,
            abi.encodeCall(Arena.joinMatch, (matchId)),
            abi.encodeWithSelector(IArena.DeadlinePassed.selector, deadline)
        );
        VM.prank(PLAYER_A);
        arena.cancelWaitingMatch(matchId);
        _checkClosedRoom(arena, matchId, GameTypes.Phase.Cancelled);
    }

    function _checkExpiry(Arena arena) private {
        uint256 matchId = _createRoom(arena);
        uint64 deadline = arena.getMatch(matchId).joinDeadline;
        VM.prank(PLAYER_B);
        _expectRevert(
            arena,
            abi.encodeCall(Arena.expireWaitingMatch, (matchId)),
            abi.encodeWithSelector(IArena.DeadlineNotPassed.selector, deadline)
        );
        VM.warp(deadline);
        VM.prank(PLAYER_B);
        _expectRevert(
            arena,
            abi.encodeCall(Arena.expireWaitingMatch, (matchId)),
            abi.encodeWithSelector(IArena.DeadlineNotPassed.selector, deadline)
        );
        VM.warp(uint256(deadline) + 1);
        VM.prank(PLAYER_B);
        arena.expireWaitingMatch(matchId);
        _checkClosedRoom(arena, matchId, GameTypes.Phase.Expired);
    }

    function _checkClosedRoom(Arena arena, uint256 matchId, GameTypes.Phase phase) private {
        GameTypes.MatchSummary memory summary = arena.getMatch(matchId);
        require(
            summary.phase == phase && summary.round == 0 && summary.stateHash == bytes32(0)
                && summary.phaseDeadline == 0 && summary.players[1] == address(0),
            "Closed room state differs"
        );
        VM.prank(PLAYER_B);
        _expectRevert(
            arena,
            abi.encodeCall(Arena.joinMatch, (matchId)),
            abi.encodeWithSelector(IArena.InvalidPhase.selector, GameTypes.Phase.Lobby, phase)
        );
        VM.prank(PLAYER_A);
        _expectRevert(
            arena,
            abi.encodeCall(Arena.cancelWaitingMatch, (matchId)),
            abi.encodeWithSelector(IArena.InvalidPhase.selector, GameTypes.Phase.Lobby, phase)
        );
    }

    function _expectRevert(Arena arena, bytes memory payload, bytes memory expected) private {
        // Inspect raw revert data to verify the exact custom error and its arguments.
        // forge-lint: disable-next-line(low-level-calls)
        (bool success, bytes memory actual) = address(arena).call(payload);
        require(!success, "Expected a lifecycle revert");
        require(actual.length == expected.length, "Unexpected lifecycle error length");
        uint256 index = 0;
        for (; index < expected.length; ++index) {
            if (actual[index] != expected[index]) break;
        }
        require(index == expected.length, "Unexpected lifecycle error data");
    }
}
