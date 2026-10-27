// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { Arena } from "../src/Arena.sol";
import { GameTypes } from "../src/GameTypes.sol";
import { GameHash } from "../src/GameHash.sol";
import { MapRules } from "../src/MapRules.sol";
import { BattleResolver } from "../src/BattleResolver.sol";
import { IArena } from "../src/IArena.sol";
import { IDevVm } from "./IDevVm.sol";

contract CheckMatches {
    IDevVm private constant VM = IDevVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address private constant PLAYER_A = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address private constant PLAYER_B = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address private constant OBSERVER = address(0xCAFE);
    uint256 private constant SQUAD_SIZE = 3;
    uint256 private constant ACTIONS_OFFSET = 21;
    uint256 private constant ACTION_WORDS = 12;
    uint256 private constant ROUND_EVENT_TOPICS = 3;
    uint256 private constant PLAYER_EVENT_TOPICS = 4;
    uint256 private constant COMMIT_TIMEOUT_MATCH_ID = 3;
    uint32 private constant DIRECTION_COUNT = 4;
    uint32 private constant DIRECTION_RIGHT = 3;
    uint8 private constant POINTS_ROUND = 7;
    uint8 private constant ELIMINATION_ROUND = 10;
    uint8 private constant RESOURCE_CELL = 18;
    uint8 private constant SCOUT_CELL = 34;
    uint8 private constant CONTROL_CELL = 35;
    bytes32 private constant SALT_A = bytes32(uint256(1));
    bytes32 private constant SALT_B = bytes32(uint256(2));
    bytes32 private constant STARTED_TOPIC = keccak256(
        "MatchStarted(uint256,(uint8,uint8,(uint8,uint8)[2],"
        "(uint8,uint8,uint8)[6],uint8,uint8),bytes32)"
    );
    bytes32 private constant REVEALED_TOPIC =
        keccak256("ActionRevealed(uint256,uint8,address,(uint8,uint8,uint8,uint8[4])[3],bytes32)");
    bytes32 private constant RESOLVED_TOPIC =
        keccak256("RoundResolved(uint256,uint8,bytes32,bytes32,(uint8,uint8)[2],uint8,uint8)");
    bytes32 private constant PHASE_TOPIC = keccak256("PhaseAdvanced(uint256,uint8,uint8,uint64)");

    struct RevealedOrders {
        GameTypes.Action[SQUAD_SIZE] a;
        GameTypes.Action[SQUAD_SIZE] b;
        bytes32 saltA;
        bytes32 saltB;
    }

    function run(address arenaAddress) external {
        Arena arena = Arena(arenaAddress);
        _checkPointsWin(arena);
        _checkEliminationWin(arena);
        _checkTimeouts(arena);
        _checkFrozen(arena, 1);
        _checkSequence(arena);
    }

    function _checkPointsWin(Arena arena) private view {
        GameTypes.BattleState memory expected = GameTypes.initialBattleState();
        expected.round = POINTS_ROUND;
        expected.players[0].energy = GameTypes.INITIAL_ENERGY - 1;
        expected.players[0].victoryPoints = GameTypes.VICTORY_THRESHOLD;
        expected.units[2].cell = CONTROL_CELL;
        expected.outcome = GameTypes.Outcome.PlayerA;
        expected.reason = GameTypes.EndReason.VictoryPoints;
        _checkTerminal(arena, 1, expected);
    }

    function _checkEliminationWin(Arena arena) private view {
        GameTypes.BattleState memory expected = GameTypes.initialBattleState();
        expected.round = ELIMINATION_ROUND;
        expected.players[0].energy = GameTypes.MAX_ENERGY;
        expected.players[1].victoryPoints = GameTypes.defaultRules().controlAward;
        expected.units[0].cell = RESOURCE_CELL;
        expected.units[2].cell = SCOUT_CELL;
        for (uint256 slot = GameTypes.SQUAD_SIZE; slot < GameTypes.UNIT_COUNT; ++slot) {
            expected.units[slot].hp = 0;
            expected.units[slot].cell = GameTypes.NO_CELL;
        }
        expected.outcome = GameTypes.Outcome.PlayerA;
        expected.reason = GameTypes.EndReason.Elimination;
        _checkTerminal(arena, 2, expected);
    }

    function _checkTimeouts(Arena arena) private view {
        GameTypes.BattleState memory expected = GameTypes.initialBattleState();
        expected.outcome = GameTypes.Outcome.PlayerA;
        expected.reason = GameTypes.EndReason.CommitTimeout;
        _checkTerminal(arena, COMMIT_TIMEOUT_MATCH_ID, expected);
        expected.outcome = GameTypes.Outcome.Draw;
        expected.reason = GameTypes.EndReason.RevealTimeout;
        _checkTerminal(arena, 4, expected);
    }

    function _checkTerminal(Arena arena, uint256 matchId, GameTypes.BattleState memory expected)
        private
        view
    {
        GameTypes.BattleState memory actual = arena.getBattleState(matchId);
        require(_sameBytes(abi.encode(actual), abi.encode(expected)), "Terminal battle differs");
        GameTypes.MatchSummary memory summary = arena.getMatch(matchId);
        require(
            summary.phase == GameTypes.Phase.Finished && summary.phaseDeadline == 0
                && summary.round == expected.round && summary.outcome == expected.outcome
                && summary.reason == expected.reason,
            "Terminal summary differs"
        );
        require(
            summary.stateHash == GameHash.hashBattleState(_context(arena, matchId), actual),
            "Terminal state hash differs"
        );
    }

    function _checkFrozen(Arena arena, uint256 matchId) private {
        uint8 round = arena.getMatch(matchId).round;
        bytes memory beforeState = _snapshot(arena, matchId);
        VM.prank(PLAYER_A);
        _expectRevert(
            arena,
            abi.encodeCall(Arena.commitActions, (matchId, round, SALT_A)),
            _phaseError(GameTypes.Phase.Commit, GameTypes.Phase.Finished)
        );
        VM.prank(PLAYER_A);
        _expectRevert(
            arena,
            abi.encodeCall(Arena.revealActions, (matchId, round, _holds(), SALT_A)),
            _phaseError(GameTypes.Phase.Reveal, GameTypes.Phase.Finished)
        );
        _expectRevert(
            arena,
            abi.encodeCall(Arena.settleRound, (matchId, round)),
            _phaseError(GameTypes.Phase.Resolvable, GameTypes.Phase.Finished)
        );
        _expectRevert(
            arena,
            abi.encodeCall(Arena.advanceExpiredPhase, (matchId, round, GameTypes.Phase.Commit)),
            _phaseError(GameTypes.Phase.Commit, GameTypes.Phase.Finished)
        );
        _expectRevert(
            arena,
            abi.encodeCall(Arena.joinMatch, (matchId)),
            _phaseError(GameTypes.Phase.Lobby, GameTypes.Phase.Finished)
        );
        VM.prank(PLAYER_A);
        _expectRevert(
            arena,
            abi.encodeCall(Arena.cancelWaitingMatch, (matchId)),
            _phaseError(GameTypes.Phase.Lobby, GameTypes.Phase.Finished)
        );
        _expectRevert(
            arena,
            abi.encodeCall(Arena.expireWaitingMatch, (matchId)),
            _phaseError(GameTypes.Phase.Lobby, GameTypes.Phase.Finished)
        );
        require(_sameBytes(beforeState, _snapshot(arena, matchId)), "Finished match changed");
    }

    function _checkSequence(Arena arena) private {
        VM.recordLogs();
        VM.prank(PLAYER_A);
        uint256 matchId = arena.createMatch(GameTypes.MAP_ID);
        VM.prank(PLAYER_B);
        arena.joinMatch(matchId);
        VM.prank(PLAYER_A);
        arena.startMatch(matchId);
        GameTypes.BattleState memory replay = _initialFromLogs(VM.getRecordedLogs(), matchId);
        _expectRevert(
            arena,
            abi.encodeCall(Arena.settleRound, (matchId, replay.round)),
            _phaseError(GameTypes.Phase.Resolvable, GameTypes.Phase.Commit)
        );
        // A bounded, reproducible legal sequence exercises actual protocol transitions.
        replay = _playRound(arena, matchId, replay, 17);
        replay = _playRound(arena, matchId, replay, 83);
        replay = _playRound(arena, matchId, replay, 211);
        _playRound(arena, matchId, replay, 503);
    }

    function _playRound(
        Arena arena,
        uint256 matchId,
        GameTypes.BattleState memory replay,
        uint32 seed
    ) private returns (GameTypes.BattleState memory next) {
        RevealedOrders memory orders = _acceptRound(arena, matchId, replay, seed);
        (next,) = BattleResolver.resolve(replay, orders.a, orders.b);
        if (replay.round == 2) {
            _expectRevert(
                arena,
                abi.encodeCall(Arena.settleRound, (matchId, uint8(1))),
                abi.encodeWithSelector(IArena.StaleRound.selector, replay.round, uint8(1))
            );
        }
        VM.recordLogs();
        VM.prank(OBSERVER);
        arena.settleRound(matchId, replay.round);
        IDevVm.Log[] memory logs = VM.getRecordedLogs();
        _checkPersisted(arena, matchId, next);
        _checkRoundEvents(logs, arena, matchId, replay, next);
        _checkClearedRound(arena, matchId);
        if (replay.round == 1) {
            bytes memory afterState = _snapshot(arena, matchId);
            _expectRevert(
                arena,
                abi.encodeCall(Arena.settleRound, (matchId, replay.round)),
                _phaseError(GameTypes.Phase.Resolvable, GameTypes.Phase.Commit)
            );
            require(
                _sameBytes(afterState, _snapshot(arena, matchId)),
                "Repeated settlement changed state"
            );
        }
    }

    function _acceptRound(
        Arena arena,
        uint256 matchId,
        GameTypes.BattleState memory replay,
        uint32 seed
    ) private returns (RevealedOrders memory decoded) {
        GameTypes.Action[SQUAD_SIZE] memory a = _sequenceOrders(replay, 0, seed);
        GameTypes.Action[SQUAD_SIZE] memory b = _sequenceOrders(replay, 1, seed + 1);
        uint8 round = replay.round;
        if (round == 2) {
            VM.prank(PLAYER_A);
            _expectRevert(
                arena,
                abi.encodeCall(Arena.commitActions, (matchId, uint8(1), SALT_A)),
                abi.encodeWithSelector(IArena.StaleRound.selector, round, uint8(1))
            );
        }
        VM.recordLogs();
        _commit(arena, matchId, round, PLAYER_A, a, SALT_A);
        _commit(arena, matchId, round, PLAYER_B, b, SALT_B);
        if (round == 2) {
            VM.prank(PLAYER_A);
            _expectRevert(
                arena,
                abi.encodeCall(Arena.revealActions, (matchId, uint8(1), a, SALT_A)),
                abi.encodeWithSelector(IArena.StaleRound.selector, round, uint8(1))
            );
        }
        VM.prank(PLAYER_A);
        arena.revealActions(matchId, round, a, SALT_A);
        if (round == 1) {
            _expectRevert(
                arena,
                abi.encodeCall(Arena.settleRound, (matchId, round)),
                _phaseError(GameTypes.Phase.Resolvable, GameTypes.Phase.Reveal)
            );
        }
        VM.prank(PLAYER_B);
        arena.revealActions(matchId, round, b, SALT_B);
        decoded = _ordersFromLogs(VM.getRecordedLogs(), arena, matchId, round);
        require(
            _sameBytes(abi.encode(a, b), abi.encode(decoded.a, decoded.b)),
            "Reveal events lost orders"
        );
        GameTypes.RoundStatus memory status = arena.getRoundStatus(matchId);
        require(
            status.commitments[0]
                    == GameHash.actionCommitment(
                        _context(arena, matchId), round, PLAYER_A, decoded.a, decoded.saltA
                    )
                && status.commitments[1]
                    == GameHash.actionCommitment(
                        _context(arena, matchId), round, PLAYER_B, decoded.b, decoded.saltB
                    ),
            "Reveal events cannot reproduce commitments"
        );
    }

    function _initialFromLogs(IDevVm.Log[] memory logs, uint256 matchId)
        private
        pure
        returns (GameTypes.BattleState memory state)
    {
        uint256 found = 0;
        for (uint256 index = 0; index < logs.length; ++index) {
            if (
                logs[index].topics.length == 2 && logs[index].topics[0] == STARTED_TOPIC
                    && logs[index].topics[1] == bytes32(matchId)
            ) {
                (state,) = abi.decode(logs[index].data, (GameTypes.BattleState, bytes32));
                ++found;
            }
        }
        require(found == 1, "Initial state event is missing or duplicated");
    }

    function _ordersFromLogs(IDevVm.Log[] memory logs, Arena arena, uint256 matchId, uint8 round)
        private
        pure
        returns (RevealedOrders memory orders)
    {
        uint256 foundA = 0;
        uint256 foundB = 0;
        for (uint256 index = 0; index < logs.length; ++index) {
            IDevVm.Log memory entry = logs[index];
            if (
                entry.emitter != address(arena) || entry.topics.length != PLAYER_EVENT_TOPICS
                    || entry.topics[0] != REVEALED_TOPIC || entry.topics[1] != bytes32(matchId)
                    || entry.topics[2] != bytes32(uint256(round))
            ) continue;
            if (entry.topics[entry.topics.length - 1] == bytes32(uint256(uint160(PLAYER_A)))) {
                (orders.a, orders.saltA) = abi.decode(entry.data, (GameTypes.Action[3], bytes32));
                ++foundA;
            } else if (entry.topics[entry.topics.length - 1] == bytes32(uint256(uint160(PLAYER_B))))
            {
                (orders.b, orders.saltB) = abi.decode(entry.data, (GameTypes.Action[3], bytes32));
                ++foundB;
            }
        }
        require(foundA == 1 && foundB == 1, "Reveal events are missing or duplicated");
    }

    function _checkPersisted(Arena arena, uint256 matchId, GameTypes.BattleState memory expected)
        private
        view
    {
        GameTypes.BattleState memory actual = arena.getBattleState(matchId);
        require(_sameBytes(abi.encode(actual), abi.encode(expected)), "Settlement storage differs");
        GameTypes.MatchSummary memory summary = arena.getMatch(matchId);
        require(
            summary.phase == GameTypes.Phase.Commit && summary.round == expected.round
                && summary.outcome == GameTypes.Outcome.None
                && summary.reason == GameTypes.EndReason.None,
            "Continuing settlement did not open the next round"
        );
        require(
            summary.phaseDeadline == VM.getBlockTimestamp() + GameTypes.PHASE_DURATION,
            "Next Commit window differs"
        );
        require(
            summary.stateHash == GameHash.hashBattleState(_context(arena, matchId), actual),
            "Persisted battle hash differs"
        );
        require(_uniqueAlive(actual.units), "Live units overlap or occupy walls");
    }

    function _checkRoundEvents(
        IDevVm.Log[] memory logs,
        Arena arena,
        uint256 matchId,
        GameTypes.BattleState memory beforeState,
        GameTypes.BattleState memory afterState
    ) private view {
        require(logs.length == 2, "Continuing settlement emitted unexpected events");
        IDevVm.Log memory entry = logs[0];
        require(
            entry.emitter == address(arena) && entry.topics.length == ROUND_EVENT_TOPICS
                && entry.topics[0] == RESOLVED_TOPIC && entry.topics[1] == bytes32(matchId)
                && entry.topics[2] == bytes32(uint256(beforeState.round)),
            "RoundResolved identity differs"
        );
        require(
            _sameBytes(
                entry.data,
                abi.encode(
                    GameHash.hashBattleState(_context(arena, matchId), beforeState),
                    GameHash.hashBattleState(_context(arena, matchId), afterState),
                    afterState.players,
                    afterState.outcome,
                    afterState.reason
                )
            ),
            "RoundResolved payload cannot reproduce the next state"
        );
        entry = logs[1];
        require(
            entry.emitter == address(arena) && entry.topics.length == ROUND_EVENT_TOPICS
                && entry.topics[0] == PHASE_TOPIC && entry.topics[1] == bytes32(matchId)
                && entry.topics[2] == bytes32(uint256(afterState.round)),
            "Next-round phase identity differs"
        );
        require(
            _sameBytes(
                entry.data,
                abi.encode(GameTypes.Phase.Commit, arena.getMatch(matchId).phaseDeadline)
            ),
            "Next-round phase payload differs"
        );
    }

    function _checkClearedRound(Arena arena, uint256 matchId) private view {
        GameTypes.RoundStatus memory status = arena.getRoundStatus(matchId);
        require(
            !status.committed[0] && !status.committed[1] && !status.revealed[0]
                && !status.revealed[1],
            "Submission flags survived settlement"
        );
        require(
            status.commitments[0] == bytes32(0) && status.commitments[1] == bytes32(0),
            "Old commitments remain"
        );
        uint256 start = uint256(keccak256(abi.encode(matchId, uint256(1)))) + ACTIONS_OFFSET;
        uint256 word = 0;
        for (; word < ACTION_WORDS; ++word) {
            // Fixed, read-only storage slots verify that no previous orders enter the next round.
            // forge-lint: disable-next-line(calls-loop, unsafe-cheatcode)
            if (VM.load(address(arena), bytes32(start + word)) != bytes32(0)) break;
        }
        require(word == ACTION_WORDS, "Old revealed orders remain");
    }

    function _sequenceOrders(GameTypes.BattleState memory state, uint8 player, uint32 seed)
        private
        pure
        returns (GameTypes.Action[SQUAD_SIZE] memory actions)
    {
        actions = _holds();
        uint64 blocked = GameTypes.defaultMap().obstacles;
        for (uint256 slot = 0; slot < GameTypes.UNIT_COUNT; ++slot) {
            if (state.units[slot].hp != 0) blocked |= uint64(1) << state.units[slot].cell;
        }
        for (uint256 slot = 0; slot < GameTypes.SQUAD_SIZE; ++slot) {
            // This reproducible local generator is unrelated to game rules or combat randomness.
            unchecked {
                seed = seed * 1_664_525 + 1_013_904_223;
            }
            GameTypes.UnitState memory unit = state.units[uint256(player) * SQUAD_SIZE + slot];
            if (unit.hp == 0 || seed % 5 == 0) continue;
            uint8 cell = _step(unit.cell, seed % DIRECTION_COUNT);
            if (MapRules.isAdjacent(unit.cell, cell) && !MapRules.contains(blocked, cell)) {
                actions[slot].kind = GameTypes.ActionKind.Move;
                actions[slot].pathLength = 1;
                actions[slot].path[0] = cell;
            }
        }
    }

    function _step(uint8 cell, uint32 direction) private pure returns (uint8) {
        if (direction == 0 && cell >= GameTypes.BOARD_SIZE) return cell - GameTypes.BOARD_SIZE;
        if (direction == 1 && cell < GameTypes.CELL_COUNT - GameTypes.BOARD_SIZE) {
            return cell + GameTypes.BOARD_SIZE;
        }
        if (direction == 2 && cell % GameTypes.BOARD_SIZE != 0) return cell - 1;
        if (direction == DIRECTION_RIGHT && cell % GameTypes.BOARD_SIZE != GameTypes.BOARD_SIZE - 1)
        {
            return cell + 1;
        }
        return cell;
    }

    function _uniqueAlive(GameTypes.UnitState[6] memory units) private pure returns (bool) {
        for (uint256 slot = 0; slot < GameTypes.UNIT_COUNT; ++slot) {
            if (units[slot].hp == 0) continue;
            if (MapRules.contains(GameTypes.defaultMap().obstacles, units[slot].cell)) {
                return false;
            }
            for (uint256 other = slot + 1; other < GameTypes.UNIT_COUNT; ++other) {
                if (units[other].hp != 0 && units[slot].cell == units[other].cell) return false;
            }
        }
        return true;
    }

    function _commit(
        Arena arena,
        uint256 matchId,
        uint8 round,
        address player,
        GameTypes.Action[SQUAD_SIZE] memory actions,
        bytes32 salt
    ) private {
        bytes32 commitment = GameHash.actionCommitment(
            _context(arena, matchId), round, player, actions, salt
        );
        VM.prank(player);
        arena.commitActions(matchId, round, commitment);
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
        for (uint256 slot = 0; slot < GameTypes.SQUAD_SIZE; ++slot) {
            actions[slot].targetCell = GameTypes.NO_CELL;
        }
    }

    function _snapshot(Arena arena, uint256 matchId) private view returns (bytes memory) {
        return abi.encode(
            arena.getMatch(matchId), arena.getBattleState(matchId), arena.getRoundStatus(matchId)
        );
    }

    function _phaseError(GameTypes.Phase expected, GameTypes.Phase actual)
        private
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(IArena.InvalidPhase.selector, expected, actual);
    }

    function _expectRevert(Arena arena, bytes memory payload, bytes memory expected) private {
        // An ordinary Arena call preserves exact custom-error data without script self-calls.
        // forge-lint: disable-next-line(low-level-calls)
        (bool success, bytes memory actual) = address(arena).call(payload);
        require(!success, "Expected a match-state revert");
        require(_sameBytes(actual, expected), "Unexpected match-state error");
    }

    function _sameBytes(bytes memory actual, bytes memory expected) private pure returns (bool) {
        if (actual.length != expected.length) return false;
        for (uint256 index = 0; index < expected.length; ++index) {
            if (actual[index] != expected[index]) return false;
        }
        return true;
    }
}
