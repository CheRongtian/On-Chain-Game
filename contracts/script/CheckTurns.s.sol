// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { Arena } from "../src/Arena.sol";
import { GameTypes } from "../src/GameTypes.sol";
import { GameHash } from "../src/GameHash.sol";
import { IArena } from "../src/IArena.sol";
import { IDevVm } from "./IDevVm.sol";

contract CheckTurns {
    IDevVm private constant VM = IDevVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address private constant PLAYER_A = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address private constant PLAYER_B = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address private constant OBSERVER = address(0xCAFE);
    uint256 private constant SQUAD_SIZE = 3;
    uint8 private constant ROUND = 1;
    uint8 private constant INVALID_STEP = 10;
    uint8 private constant RANGER_TARGET = 27;
    bytes32 private constant SALT_A = bytes32(uint256(1));
    bytes32 private constant SALT_B = bytes32(uint256(2));

    // _matches is slot 1. Summary, battle, and status occupy 7 + 10 + 4 slots.
    uint256 private constant REVEALED_ACTIONS_OFFSET = 21;
    uint256 private constant ACTION_STORAGE_SLOTS = 2;
    uint256 private constant MATCH_EVENT_TOPICS = 3;
    bytes32 private constant COMMITTED_TOPIC =
        keccak256("ActionCommitted(uint256,uint8,address,bytes32)");
    bytes32 private constant REVEALED_TOPIC =
        keccak256("ActionRevealed(uint256,uint8,address,(uint8,uint8,uint8,uint8[4])[3],bytes32)");
    bytes32 private constant PHASE_TOPIC = keccak256("PhaseAdvanced(uint256,uint8,uint8,uint64)");
    bytes32 private constant FINISHED_TOPIC =
        keccak256("MatchFinished(uint256,uint8,address,uint8,uint8,bytes32)");

    function run(address arenaAddress) external {
        Arena arena = Arena(arenaAddress);
        _checkResolvable(arena, 1);
        _checkStoredOrders(arena, 1, 2);
        uint256 guardedMatch = _checkCommitGuards(arena);
        _checkRevealGuards(arena, guardedMatch);
        _checkInvalidEncoding(arena);
        _checkInvalidPath(arena);
        _checkBudget(arena);
        _checkContextReplay(arena);
        _checkInclusiveDeadlines(arena);
        _checkCommitTimeout(arena, GameTypes.Outcome.Draw);
        _checkCommitTimeout(arena, GameTypes.Outcome.PlayerA);
        _checkCommitTimeout(arena, GameTypes.Outcome.PlayerB);
        _checkRevealTimeout(arena, GameTypes.Outcome.Draw);
        _checkRevealTimeout(arena, GameTypes.Outcome.PlayerA);
        _checkRevealTimeout(arena, GameTypes.Outcome.PlayerB);
    }

    function _checkCommitGuards(Arena arena) private returns (uint256 matchId) {
        matchId = _openMatch(arena);
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        bytes32 commitment = _commitment(arena, matchId, PLAYER_A, actions, SALT_A);
        _expectRevert(
            arena, abi.encodeCall(Arena.commitActions, (uint256(0), ROUND, commitment)),
            abi.encodeWithSelector(IArena.UnknownMatch.selector, uint256(0))
        );
        VM.prank(OBSERVER);
        _expectRevert(
            arena, abi.encodeCall(Arena.commitActions, (matchId, ROUND, commitment)),
            abi.encodeWithSelector(IArena.NotPlayer.selector, OBSERVER)
        );
        VM.prank(PLAYER_A);
        _expectRevert(
            arena, abi.encodeCall(Arena.commitActions, (matchId, uint8(0), commitment)),
            abi.encodeWithSelector(IArena.StaleRound.selector, ROUND, uint8(0))
        );
        _checkStoredOrders(arena, matchId, 0);
        VM.recordLogs();
        _commit(arena, matchId, PLAYER_A, actions, SALT_A);
        IDevVm.Log[] memory logs = VM.getRecordedLogs();
        require(logs.length == 1, "First Commit emitted unexpected events");
        _checkPlayerLog(logs[0], arena, matchId, COMMITTED_TOPIC, PLAYER_A);
        require(_sameBytes(logs[0].data, abi.encode(commitment)), "Commit exposed extra data");
        VM.prank(PLAYER_A);
        _expectRevert(
            arena, abi.encodeCall(Arena.commitActions, (matchId, ROUND, SALT_B)),
            abi.encodeWithSelector(IArena.AlreadyCommitted.selector, PLAYER_A)
        );
        VM.prank(PLAYER_A);
        _expectRevert(
            arena, abi.encodeCall(Arena.revealActions, (matchId, ROUND, actions, SALT_A)),
            abi.encodeWithSelector(
                IArena.InvalidPhase.selector, GameTypes.Phase.Reveal, GameTypes.Phase.Commit
            )
        );
        _expectRevert(
            arena,
            abi.encodeCall(Arena.advanceExpiredPhase, (matchId, ROUND, GameTypes.Phase.Resolvable)),
            abi.encodeWithSelector(IArena.InvalidTimeoutPhase.selector, GameTypes.Phase.Resolvable)
        );
        _expectRevert(
            arena,
            abi.encodeCall(Arena.advanceExpiredPhase, (matchId, ROUND, GameTypes.Phase.Reveal)),
            abi.encodeWithSelector(
                IArena.InvalidPhase.selector, GameTypes.Phase.Reveal, GameTypes.Phase.Commit
            )
        );
        _expectRevert(
            arena,
            abi.encodeCall(Arena.advanceExpiredPhase, (matchId, uint8(0), GameTypes.Phase.Commit)),
            abi.encodeWithSelector(IArena.StaleRound.selector, ROUND, uint8(0))
        );
        VM.recordLogs();
        _commit(arena, matchId, PLAYER_B, actions, SALT_B);
        logs = VM.getRecordedLogs();
        require(logs.length == 2, "Second Commit emitted unexpected events");
        _checkPlayerLog(logs[0], arena, matchId, COMMITTED_TOPIC, PLAYER_B);
        _checkPhaseLog(
            logs[1], arena, matchId, GameTypes.Phase.Reveal, arena.getMatch(matchId).phaseDeadline
        );
        _checkRejectedState(arena, matchId);
    }

    function _checkRevealGuards(Arena arena, uint256 matchId) private {
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        VM.prank(OBSERVER);
        _expectRevert(
            arena, abi.encodeCall(Arena.revealActions, (matchId, ROUND, actions, SALT_A)),
            abi.encodeWithSelector(IArena.NotPlayer.selector, OBSERVER)
        );
        VM.prank(PLAYER_A);
        _expectRevert(
            arena, abi.encodeCall(Arena.revealActions, (matchId, ROUND + 1, actions, SALT_A)),
            abi.encodeWithSelector(IArena.StaleRound.selector, ROUND, ROUND + 1)
        );
        _rejectReveal(
            arena, matchId, actions, SALT_B,
            abi.encodeWithSelector(IArena.CommitmentMismatch.selector)
        );
        VM.recordLogs();
        _reveal(arena, matchId, PLAYER_A, actions, SALT_A);
        IDevVm.Log[] memory logs = VM.getRecordedLogs();
        require(logs.length == 1, "First Reveal emitted unexpected events");
        _checkPlayerLog(logs[0], arena, matchId, REVEALED_TOPIC, PLAYER_A);
        require(_sameBytes(logs[0].data, abi.encode(actions, SALT_A)), "Reveal payload differs");
        _checkStoredOrders(arena, matchId, 1);
        VM.prank(PLAYER_A);
        _expectRevert(
            arena, abi.encodeCall(Arena.revealActions, (matchId, ROUND, actions, SALT_A)),
            abi.encodeWithSelector(IArena.AlreadyRevealed.selector, PLAYER_A)
        );
        VM.recordLogs();
        _reveal(arena, matchId, PLAYER_B, actions, SALT_B);
        logs = VM.getRecordedLogs();
        require(logs.length == 2, "Second Reveal emitted unexpected events");
        _checkPlayerLog(logs[0], arena, matchId, REVEALED_TOPIC, PLAYER_B);
        _checkPhaseLog(logs[1], arena, matchId, GameTypes.Phase.Resolvable, 0);
        _checkResolvable(arena, matchId);
        _checkStoredOrders(arena, matchId, 2);
        VM.prank(PLAYER_B);
        _expectRevert(
            arena, abi.encodeCall(Arena.commitActions, (matchId, ROUND, SALT_B)),
            abi.encodeWithSelector(
                IArena.InvalidPhase.selector, GameTypes.Phase.Commit, GameTypes.Phase.Resolvable
            )
        );
        VM.prank(PLAYER_B);
        _expectRevert(
            arena, abi.encodeCall(Arena.revealActions, (matchId, ROUND, actions, SALT_B)),
            abi.encodeWithSelector(
                IArena.InvalidPhase.selector, GameTypes.Phase.Reveal, GameTypes.Phase.Resolvable
            )
        );
        _expectRevert(
            arena,
            abi.encodeCall(Arena.advanceExpiredPhase, (matchId, ROUND, GameTypes.Phase.Reveal)),
            abi.encodeWithSelector(
                IArena.InvalidPhase.selector, GameTypes.Phase.Reveal, GameTypes.Phase.Resolvable
            )
        );
    }

    function _checkInvalidEncoding(Arena arena) private {
        uint256 matchId = _openMatch(arena);
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        VM.prank(PLAYER_A);
        arena.commitActions(matchId, ROUND, bytes32(0));
        _commit(arena, matchId, PLAYER_B, actions, SALT_B);
        actions[0].targetCell = 0;
        _rejectReveal(
            arena, matchId, actions, SALT_A,
            abi.encodeWithSelector(IArena.InvalidActionEncoding.selector, uint8(0))
        );
    }

    function _checkInvalidPath(Arena arena) private {
        uint256 matchId = _openMatch(arena);
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        actions[0].kind = GameTypes.ActionKind.Move;
        actions[0].pathLength = 1;
        actions[0].path[0] = INVALID_STEP;
        _commitBoth(arena, matchId, actions);
        _rejectReveal(
            arena, matchId, actions, SALT_A,
            abi.encodeWithSelector(IArena.InvalidPath.selector, uint8(0))
        );
    }

    function _checkBudget(Arena arena) private {
        uint256 matchId = _openMatch(arena);
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        actions[0].kind = GameTypes.ActionKind.Shield;
        actions[1].kind = GameTypes.ActionKind.PowerShot;
        actions[1].targetCell = RANGER_TARGET;
        _commitBoth(arena, matchId, actions);
        _rejectReveal(
            arena, matchId, actions, SALT_A,
            abi.encodeWithSelector(
                IArena.InsufficientEnergy.selector, uint8(0), GameTypes.INITIAL_ENERGY + 1,
                GameTypes.INITIAL_ENERGY
            )
        );
    }

    function _checkContextReplay(Arena arena) private {
        uint256 sourceMatch = _openMatch(arena);
        uint256 targetMatch = _openMatch(arena);
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        bytes32 commitment = _commitment(arena, sourceMatch, PLAYER_A, actions, SALT_A);
        VM.prank(PLAYER_A);
        arena.commitActions(targetMatch, ROUND, commitment);
        _commit(arena, targetMatch, PLAYER_B, actions, SALT_B);
        _rejectReveal(
            arena, targetMatch, actions, SALT_A,
            abi.encodeWithSelector(IArena.CommitmentMismatch.selector)
        );
    }

    function _checkInclusiveDeadlines(Arena arena) private {
        uint256 matchId = _openMatch(arena);
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        VM.warp(arena.getMatch(matchId).phaseDeadline);
        _commitBoth(arena, matchId, actions);
        require(
            arena.getMatch(matchId).phaseDeadline
                == VM.getBlockTimestamp() + GameTypes.PHASE_DURATION,
            "Reveal did not open a fresh window"
        );
        VM.warp(arena.getMatch(matchId).phaseDeadline);
        _reveal(arena, matchId, PLAYER_A, actions, SALT_A);
        _reveal(arena, matchId, PLAYER_B, actions, SALT_B);
        _checkResolvable(arena, matchId);
    }

    function _checkCommitTimeout(Arena arena, GameTypes.Outcome expected) private {
        uint256 matchId = _openMatch(arena);
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        if (expected == GameTypes.Outcome.PlayerA) {
            _commit(arena, matchId, PLAYER_A, actions, SALT_A);
        } else if (expected == GameTypes.Outcome.PlayerB) {
            _commit(arena, matchId, PLAYER_B, actions, SALT_B);
        }
        uint64 deadline = arena.getMatch(matchId).phaseDeadline;
        if (expected == GameTypes.Outcome.Draw) {
            VM.warp(deadline);
            _expectRevert(
                arena,
                abi.encodeCall(Arena.advanceExpiredPhase, (matchId, ROUND, GameTypes.Phase.Commit)),
                abi.encodeWithSelector(IArena.DeadlineNotPassed.selector, deadline)
            );
        }
        VM.warp(uint256(deadline) + 1);
        if (expected == GameTypes.Outcome.Draw) {
            VM.prank(PLAYER_A);
            _expectRevert(
                arena, abi.encodeCall(Arena.commitActions, (matchId, ROUND, SALT_A)),
                abi.encodeWithSelector(IArena.DeadlinePassed.selector, deadline)
            );
        }
        _expireAndCheck(arena, matchId, GameTypes.Phase.Commit, expected);
    }

    function _checkRevealTimeout(Arena arena, GameTypes.Outcome expected) private {
        uint256 matchId = _openMatch(arena);
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        _commitBoth(arena, matchId, actions);
        if (expected == GameTypes.Outcome.PlayerA) {
            _reveal(arena, matchId, PLAYER_A, actions, SALT_A);
        } else if (expected == GameTypes.Outcome.PlayerB) {
            _reveal(arena, matchId, PLAYER_B, actions, SALT_B);
        }
        uint64 deadline = arena.getMatch(matchId).phaseDeadline;
        if (expected == GameTypes.Outcome.Draw) {
            VM.warp(deadline);
            _expectRevert(
                arena,
                abi.encodeCall(Arena.advanceExpiredPhase, (matchId, ROUND, GameTypes.Phase.Reveal)),
                abi.encodeWithSelector(IArena.DeadlineNotPassed.selector, deadline)
            );
        }
        VM.warp(uint256(deadline) + 1);
        if (expected == GameTypes.Outcome.Draw) {
            VM.prank(PLAYER_A);
            _expectRevert(
                arena, abi.encodeCall(Arena.revealActions, (matchId, ROUND, actions, SALT_A)),
                abi.encodeWithSelector(IArena.DeadlinePassed.selector, deadline)
            );
        }
        _expireAndCheck(arena, matchId, GameTypes.Phase.Reveal, expected);
    }

    function _expireAndCheck(
        Arena arena, uint256 matchId, GameTypes.Phase phase, GameTypes.Outcome outcome
    ) private {
        VM.recordLogs();
        VM.prank(OBSERVER);
        arena.advanceExpiredPhase(matchId, ROUND, phase);
        IDevVm.Log[] memory logs = VM.getRecordedLogs();
        GameTypes.EndReason reason = phase == GameTypes.Phase.Commit
            ? GameTypes.EndReason.CommitTimeout : GameTypes.EndReason.RevealTimeout;
        GameTypes.MatchSummary memory summary = arena.getMatch(matchId);
        require(
            summary.phase == GameTypes.Phase.Finished && summary.phaseDeadline == 0
                && summary.round == ROUND && summary.outcome == outcome && summary.reason == reason,
            "Timeout summary differs"
        );
        GameTypes.BattleState memory expected = GameTypes.initialBattleState();
        expected.outcome = outcome;
        expected.reason = reason;
        bytes32 expectedHash = GameHash.hashBattleState(_context(arena, matchId), expected);
        require(summary.stateHash == expectedHash, "Timeout hash differs");
        require(
            GameHash.hashBattleState(_context(arena, matchId), arena.getBattleState(matchId))
                == expectedHash,
            "Timeout changed the board, resources, or round"
        );
        _checkFinishedLogs(logs, arena, matchId, summary);
        _expectRevert(
            arena, abi.encodeCall(Arena.advanceExpiredPhase, (matchId, ROUND, phase)),
            abi.encodeWithSelector(IArena.InvalidPhase.selector, phase, GameTypes.Phase.Finished)
        );
        require(arena.getMatch(matchId).stateHash == expectedHash, "Repeated timeout changed state");
    }

    function _checkFinishedLogs(
        IDevVm.Log[] memory logs, Arena arena, uint256 matchId,
        GameTypes.MatchSummary memory summary
    ) private pure {
        require(logs.length == 2, "Timeout emitted unexpected events");
        _checkPhaseLog(logs[0], arena, matchId, GameTypes.Phase.Finished, 0);
        address winner = address(0);
        if (summary.outcome == GameTypes.Outcome.PlayerA) winner = PLAYER_A;
        else if (summary.outcome == GameTypes.Outcome.PlayerB) winner = PLAYER_B;
        require(
            logs[1].emitter == address(arena) && logs[1].topics.length == MATCH_EVENT_TOPICS
                && logs[1].topics[0] == FINISHED_TOPIC && logs[1].topics[1] == bytes32(matchId)
                && logs[1].topics[2] == bytes32(uint256(uint160(winner)))
                && _sameBytes(
                    logs[1].data, abi.encode(ROUND, summary.outcome, summary.reason, summary.stateHash)
                ),
            "Timeout finish event differs"
        );
    }

    function _checkPhaseLog(
        IDevVm.Log memory entry, Arena arena, uint256 matchId, GameTypes.Phase phase,
        uint64 deadline
    ) private pure {
        require(
            entry.emitter == address(arena) && entry.topics.length == MATCH_EVENT_TOPICS
                && entry.topics[0] == PHASE_TOPIC && entry.topics[1] == bytes32(matchId)
                && entry.topics[2] == bytes32(uint256(ROUND))
                && _sameBytes(entry.data, abi.encode(phase, deadline)),
            "Phase event differs"
        );
    }

    function _checkPlayerLog(
        IDevVm.Log memory entry, Arena arena, uint256 matchId, bytes32 topic, address player
    ) private pure {
        require(
            entry.emitter == address(arena) && entry.topics.length == 4 && entry.topics[0] == topic
                && entry.topics[1] == bytes32(matchId)
                && entry.topics[2] == bytes32(uint256(ROUND))
                && entry.topics[3] == bytes32(uint256(uint160(player))),
            "Player event identity differs"
        );
    }

    function _checkResolvable(Arena arena, uint256 matchId) private view {
        GameTypes.MatchSummary memory summary = arena.getMatch(matchId);
        GameTypes.RoundStatus memory status = arena.getRoundStatus(matchId);
        require(
            summary.phase == GameTypes.Phase.Resolvable && summary.phaseDeadline == 0
                && summary.round == ROUND && status.committed[0] && status.committed[1]
                && status.revealed[0] && status.revealed[1],
            "Both valid Reveals did not make the round Resolvable"
        );
        _checkBoardUnchanged(arena, matchId);
    }

    function _checkRejectedState(Arena arena, uint256 matchId) private view {
        GameTypes.RoundStatus memory status = arena.getRoundStatus(matchId);
        require(
            status.committed[0] && status.committed[1] && !status.revealed[0] && !status.revealed[1]
                && arena.getMatch(matchId).phase == GameTypes.Phase.Reveal,
            "Rejected Reveal changed submission flags or phase"
        );
        _checkBoardUnchanged(arena, matchId);
        _checkStoredOrders(arena, matchId, 0);
    }

    function _checkBoardUnchanged(Arena arena, uint256 matchId) private view {
        bytes32 expectedHash =
            GameHash.hashBattleState(_context(arena, matchId), GameTypes.initialBattleState());
        require(
            arena.getMatch(matchId).stateHash == expectedHash
                && GameHash.hashBattleState(_context(arena, matchId), arena.getBattleState(matchId))
                    == expectedHash,
            "Submission changed the board, resources, result, or round"
        );
    }

    function _checkStoredOrders(Arena arena, uint256 matchId, uint256 revealedPlayers) private view {
        // Read the actual mapping storage; a later HOLD Reveal confirms this offset.
        uint256 start = uint256(keccak256(abi.encode(matchId, uint256(1))))
            + REVEALED_ACTIONS_OFFSET;
        uint256 slot = 0;
        for (; slot < GameTypes.UNIT_COUNT; ++slot) {
            uint256 expected = slot < revealedPlayers * SQUAD_SIZE
                ? uint256(GameTypes.NO_CELL) << 8 : 0;
            // These fixed, read-only slots verify the Commit/Reveal privacy boundary.
            // forge-lint: disable-next-line(calls-loop, unsafe-cheatcode)
            bytes32 header = VM.load(address(arena), bytes32(start + slot * ACTION_STORAGE_SLOTS));
            // forge-lint: disable-next-line(calls-loop, unsafe-cheatcode)
            bytes32 path = VM.load(address(arena), bytes32(start + slot * ACTION_STORAGE_SLOTS + 1));
            if (header != bytes32(expected) || path != bytes32(0)) break;
        }
        require(slot == GameTypes.UNIT_COUNT, "Stored orders differ from accepted Reveals");
    }

    function _rejectReveal(
        Arena arena, uint256 matchId, GameTypes.Action[SQUAD_SIZE] memory actions, bytes32 salt,
        bytes memory expected
    ) private {
        VM.recordLogs();
        VM.prank(PLAYER_A);
        _expectRevert(
            arena, abi.encodeCall(Arena.revealActions, (matchId, ROUND, actions, salt)), expected
        );
        require(VM.getRecordedLogs().length == 0, "Rejected Reveal emitted events");
        _checkRejectedState(arena, matchId);
    }

    function _openMatch(Arena arena) private returns (uint256 matchId) {
        VM.prank(PLAYER_A);
        matchId = arena.createMatch(GameTypes.MAP_ID);
        VM.prank(PLAYER_B);
        arena.joinMatch(matchId);
    }

    function _commitBoth(
        Arena arena, uint256 matchId, GameTypes.Action[SQUAD_SIZE] memory actionsA
    ) private {
        _commit(arena, matchId, PLAYER_A, actionsA, SALT_A);
        _commit(arena, matchId, PLAYER_B, _holds(), SALT_B);
    }

    function _commit(
        Arena arena, uint256 matchId, address player, GameTypes.Action[SQUAD_SIZE] memory actions,
        bytes32 salt
    ) private {
        bytes32 commitment = _commitment(arena, matchId, player, actions, salt);
        VM.prank(player);
        arena.commitActions(matchId, ROUND, commitment);
    }

    function _reveal(
        Arena arena, uint256 matchId, address player, GameTypes.Action[SQUAD_SIZE] memory actions,
        bytes32 salt
    ) private {
        VM.prank(player);
        arena.revealActions(matchId, ROUND, actions, salt);
    }

    function _commitment(
        Arena arena, uint256 matchId, address player, GameTypes.Action[SQUAD_SIZE] memory actions,
        bytes32 salt
    ) private view returns (bytes32) {
        return GameHash.actionCommitment(_context(arena, matchId), ROUND, player, actions, salt);
    }

    function _context(Arena arena, uint256 matchId)
        private
        view
        returns (GameTypes.MatchContext memory)
    {
        return GameTypes.MatchContext({
            chainId: block.chainid, arena: address(arena), matchId: matchId
        });
    }

    function _holds() private pure returns (GameTypes.Action[SQUAD_SIZE] memory actions) {
        for (uint256 slot = 0; slot < SQUAD_SIZE; ++slot) {
            actions[slot].targetCell = GameTypes.NO_CELL;
        }
    }

    function _expectRevert(Arena arena, bytes memory payload, bytes memory expected) private {
        // Inspect exact custom-error data from the ordinary Arena call boundary.
        // forge-lint: disable-next-line(low-level-calls)
        (bool success, bytes memory actual) = address(arena).call(payload);
        require(!success, "Expected a turn-protocol revert");
        require(_sameBytes(actual, expected), "Unexpected turn-protocol error");
    }

    function _sameBytes(bytes memory actual, bytes memory expected) private pure returns (bool) {
        if (actual.length != expected.length) return false;
        for (uint256 index = 0; index < expected.length; ++index) {
            if (actual[index] != expected[index]) return false;
        }
        return true;
    }
}
