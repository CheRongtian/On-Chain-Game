// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadRevealFixture } from "./SquadReveal.t.sol";
import { SquadCodec } from "../src/SquadCodec.sol";
import { SquadProtocol as Protocol } from "../src/SquadProtocol.sol";
import { SquadRules } from "../src/SquadRules.sol";
import { SquadBattleResolver as Resolver } from "../src/SquadBattleResolver.sol";
import { SquadSafetySupport as Support } from "./SquadSafetySupport.sol";
import { ISquadEvents } from "../src/ISquadArena.sol";
import { IDevVm } from "../script/IDevVm.sol";

// Shared bounded fixtures exercise real protocol transactions, readable cells and exact reverts.
// forge-lint: disable-start(multi-contract-file,literal-instead-of-constant,calls-loop,require-revert-in-loop)
abstract contract SquadBattleFixture is SquadRevealFixture {
    struct Frame {
        SquadCodec.State initial;
        SquadCodec.Action[3][2] actions;
        SquadCodec.State next;
        SquadCodec.Effects effects;
    }

    struct GameOrders {
        uint8[3] a;
        uint8[3] b;
        // Separate ABI bundles avoid the frozen non-IR compiler's nested-array decoder stack limit.
        bytes[] rounds;
    }

    function _battle(uint8 mapId) internal returns (uint256 id) {
        id = _ready(mapId, _a(), _b(), SALT_A, SALT_B);
        _reveal(id, HOST, _a(), SALT_A);
        _reveal(id, GUEST, _b(), SALT_B);
    }

    function _turnHash(
        uint256 id,
        uint16 round,
        address player,
        SquadCodec.Action[3] memory actions,
        bytes32 salt
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                SquadCodec.domain(2),
                _context(id),
                round,
                player,
                arena.getRulesetId(),
                actions,
                salt
            )
        );
    }

    function _turnCommit(uint256 id, uint16 round, address player, bytes32 hash) internal {
        VM.prank(player);
        arena.commitActions(id, round, hash);
    }

    function _turnReveal(
        uint256 id,
        uint16 round,
        address player,
        SquadCodec.Action[3] memory actions,
        bytes32 salt
    ) internal {
        VM.prank(player);
        arena.revealActions(id, round, actions, salt);
    }

    function _commitBoth(uint256 id, SquadCodec.Action[3][2] memory actions) internal {
        uint16 round = arena.getMatch(id).activeRound;
        bytes32 a = _turnHash(id, round, HOST, actions[0], SALT_A);
        bytes32 b = _turnHash(id, round, GUEST, actions[1], SALT_B);
        _turnCommit(id, round, HOST, a);
        _turnCommit(id, round, GUEST, b);
    }

    function _revealBoth(uint256 id, SquadCodec.Action[3][2] memory actions, bool guestFirst)
        internal
    {
        uint16 round = arena.getMatch(id).activeRound;
        _turnReveal(
            id,
            round,
            guestFirst ? GUEST : HOST,
            actions[guestFirst ? 1 : 0],
            guestFirst ? SALT_B : SALT_A
        );
        _turnReveal(
            id,
            round,
            guestFirst ? HOST : GUEST,
            actions[guestFirst ? 0 : 1],
            guestFirst ? SALT_A : SALT_B
        );
    }

    function _round(uint256 id, SquadCodec.Action[3][2] memory actions, bool guestFirst)
        internal
        returns (Frame memory frame)
    {
        frame.initial = arena.getBattleState(id);
        frame.actions = actions;
        (frame.next, frame.effects,) = Resolver.resolve(frame.initial, actions);
        _commitBoth(id, actions);
        _revealBoth(id, actions, guestFirst);
        _equal(abi.encode(arena.getBattleState(id)), abi.encode(frame.initial), "reveal.battle");
        uint16 round = arena.getMatch(id).activeRound;
        bytes32 beforeHash = arena.getMatch(id).stateHash;
        VM.recordLogs();
        VM.prank(OBSERVER);
        arena.settleRound(id, round);
        IDevVm.Log[] memory logs = VM.getRecordedLogs();
        bytes32 afterHash = SquadRules.hashState(_context(id), frame.next);
        require(logs.length == (frame.next.outcome == 0 ? 2 : 3), "Settlement event count");
        require(logs[0].topics[0] == ISquadEvents.RoundResolved.selector, "RoundResolved topic");
        require(
            logs[0].topics[1] == bytes32(id) && logs[0].topics[2] == bytes32(uint256(round)),
            "RoundResolved identity"
        );
        _equal(
            logs[0].data,
            abi.encode(beforeHash, afterHash, frame.next, frame.effects),
            "RoundResolved.data"
        );
        require(logs[1].topics[0] == ISquadEvents.PhaseAdvanced.selector, "Phase event order");
        _equal(abi.encode(arena.getBattleState(id)), abi.encode(frame.next), "settlement.state");
        SquadCodec.MatchSummary memory summary = arena.getMatch(id);
        require(
            summary.stateHash == afterHash && summary.outcome == frame.next.outcome
                && summary.reason == frame.next.reason,
            "Summary state/result"
        );
        require(
            summary.activeRound == (frame.next.outcome == 0 ? round + 1 : round), "Active round"
        );
        require(
            summary.phase == (frame.next.outcome == 0 ? Protocol.ROUND_COMMIT : Protocol.FINISHED),
            "Next phase"
        );
        require(
            summary.mapId == frame.initial.mapId && summary.rulesetId == arena.getRulesetId()
                && summary.players[0] == HOST && summary.players[1] == GUEST,
            "Metadata changed"
        );
        if (frame.next.outcome == 0) {
            SquadCodec.RoundStatus memory empty;
            _equal(abi.encode(arena.getRoundStatus(id)), abi.encode(empty), "next.emptyTurn");
            require(summary.phaseDeadline == VM.getBlockTimestamp() + 600, "Next round deadline");
        } else {
            require(summary.phaseDeadline == 0, "Terminal deadline");
            require(logs[2].topics[0] == ISquadEvents.MatchFinished.selector, "Finish topic");
            address winner =
                frame.next.outcome == 1 ? HOST : frame.next.outcome == 2 ? GUEST : address(0);
            require(logs[2].topics[2] == bytes32(uint256(uint160(winner))), "Winner");
            _equal(
                logs[2].data,
                abi.encode(
                    round,
                    true,
                    frame.next.completedRound,
                    frame.next.outcome,
                    frame.next.reason,
                    afterHash
                ),
                "MatchFinished.data"
            );
        }
    }

    function _rejectTurn(uint256 id, address player, bytes memory payload, bytes memory reason)
        internal
    {
        bytes memory before_ = _snapshot(id);
        _rejectCall(player, payload, reason);
        _equal(_snapshot(id), before_, "turn.rejection.rollback");
    }

    function _move(uint8 a, uint8 b) internal pure returns (SquadCodec.Action memory action) {
        action = Support.hold();
        action.actionType = 1;
        action.pathLength = b == 255 ? 1 : 2;
        action.pathBits = uint32(a) | (b == 255 ? 0 : uint32(b) << 6);
    }

    function _witness(uint16 round) internal pure returns (SquadCodec.Action[3][2] memory actions) {
        actions = Support.holds();
        if (round == 1) {
            actions[0][0] = _move(9, 255);
            actions[0][1] = _move(32, 33);
            actions[0][2] = _move(48, 49);
            actions[1][0] = SquadCodec.Action(1, 255, 255, 3, uint32(54 | (53 << 6) | (52 << 12)));
            actions[1][1] = _move(38, 37);
        } else if (round == 2) {
            actions[0][0] = _move(10, 255);
            actions[0][1] = _move(34, 255);
            actions[0][2] = _move(50, 42);
            actions[1][0] = _move(51, 43);
            actions[1][1] = _move(45, 255);
        } else if (round == 3) {
            actions[0][0] = _move(18, 255);
            actions[1][1] = SquadCodec.Action(2, 42, 255, 0, 0);
        } else if (round == 4) {
            actions[0][2] = SquadCodec.Action(3, 43, 255, 0, 0);
            actions[1][1] = SquadCodec.Action(2, 42, 255, 0, 0);
        } else if (round == 5) {
            actions[0][1] = SquadCodec.Action(3, 255, 2, 0, 0);
            actions[1][0] = _move(51, 255);
        } else if (round == 6) {
            actions[1][0] =
                SquadCodec.Action(3, 255, 255, 4, uint32(52 | (53 << 6) | (54 << 12) | (55 << 18)));
            actions[1][1] = SquadCodec.Action(3, 42, 255, 0, 0);
        } else if (round == 7) {
            actions[0][1] = SquadCodec.Action(3, 255, 2, 0, 0);
            actions[0][2] = SquadCodec.Action(2, 43, 255, 0, 0);
        } else if (round >= 8 && round <= 10) {
            actions[1][1] = SquadCodec.Action(3, 42, 255, 0, 0);
        }
    }
}

contract SquadBattleTest is SquadBattleFixture {
    function testCommitPrivacyAndImmutability() public {
        uint256 id = _battle(1);
        bytes memory before_ = abi.encode(arena.getBattleState(id));
        uint64 deadline = arena.getMatch(id).phaseDeadline;
        _turnCommit(id, 1, HOST, SALT_A);
        require(arena.getMatch(id).phaseDeadline == deadline, "First Commit extended window");
        require(
            arena.getRoundStatus(id).committed[0] && !arena.getRoundStatus(id).revealed[0],
            "Commit flags"
        );
        _rejectTurn(
            id,
            HOST,
            abi.encodeCall(arena.commitActions, (id, 1, SALT_B)),
            abi.encodeWithSelector(Protocol.AlreadyCommitted.selector, HOST)
        );
        VM.warp(deadline);
        _turnCommit(id, 1, GUEST, SALT_B);
        require(
            arena.getMatch(id).phase == Protocol.ROUND_REVEAL
                && arena.getMatch(id).phaseDeadline == deadline + 600,
            "Reveal window"
        );
        _equal(abi.encode(arena.getBattleState(id)), before_, "commit.noBattleWrites");
    }

    function testRevealRetryPrivacyAndPayload() public {
        uint256 id = _battle(1);
        SquadCodec.Action[3][2] memory actions = Support.allMoves(arena.getBattleState(id));
        _commitBoth(id, actions);
        _rejectTurn(
            id,
            HOST,
            abi.encodeCall(arena.revealActions, (id, 1, actions[0], SALT_B)),
            abi.encodeWithSelector(Protocol.CommitmentMismatch.selector)
        );
        bytes memory before_ = abi.encode(arena.getBattleState(id));
        uint64 deadline = arena.getMatch(id).phaseDeadline;
        VM.recordLogs();
        _turnReveal(id, 1, HOST, actions[0], SALT_A);
        IDevVm.Log[] memory logs = VM.getRecordedLogs();
        require(
            logs.length == 1 && logs[0].topics[0] == ISquadEvents.ActionRevealed.selector,
            "First Reveal event"
        );
        _equal(logs[0].data, abi.encode(actions[0], SALT_A), "ActionRevealed.data");
        require(
            arena.getMatch(id).phaseDeadline == deadline && !arena.getRoundStatus(id).revealed[1],
            "First Reveal privacy/deadline"
        );
        _equal(abi.encode(arena.getBattleState(id)), before_, "firstReveal.noEffects");
        _rejectTurn(
            id,
            HOST,
            abi.encodeCall(arena.revealActions, (id, 1, actions[0], SALT_A)),
            abi.encodeWithSelector(Protocol.AlreadyRevealed.selector, HOST)
        );
        _turnReveal(id, 1, GUEST, actions[1], SALT_B);
        require(
            arena.getMatch(id).phase == Protocol.RESOLVABLE
                && arena.getMatch(id).phaseDeadline == 0,
            "Both Reveal phase"
        );
        _equal(abi.encode(arena.getBattleState(id)), before_, "secondReveal.noEffects");
    }

    // Each malformed bundle deliberately shares the same full-rollback and replacement assertions.
    // forge-lint: disable-next-item(cyclomatic-complexity)
    function testMalformedCommittedBundlesRollbackAndCannotBeReplaced() public {
        for (uint256 kind = 0; kind < 11; ++kind) {
            uint256 id = _battle(1);
            SquadCodec.Action[3][2] memory actions = Support.holds();
            if (kind == 0) actions[0][0].targetCell = 0;
            if (kind == 1) actions[0][0].pathBits = 1;
            if (kind == 2) actions[0][0] = _move(9, 10);
            if (kind == 3) actions[0][1] = SquadCodec.Action(3, 255, 3, 0, 0);
            if (kind == 4) actions[0][2] = SquadCodec.Action(3, 43, 255, 0, 0);
            if (kind == 5) actions[0][0] = SquadCodec.Action(3, 0, 255, 0, 0);
            if (kind == 6) {
                actions[0][1] = SquadCodec.Action(3, 255, 1, 0, 0);
                actions[0][2] = SquadCodec.Action(3, 48, 255, 0, 0);
            }
            if (kind == 7) actions[0][1] = _move(25, 17);
            if (kind == 8) actions[0][1] = _move(16, 8);
            if (kind == 9) actions[0][1] = _move(26, 255);
            if (kind == 10) actions[0][1] = _move(25, 25);
            _commitBoth(id, actions);
            if (kind % 2 == 0) _turnReveal(id, 1, GUEST, actions[1], SALT_B);
            _rejectTurn(
                id,
                HOST,
                abi.encodeCall(arena.revealActions, (id, 1, actions[0], SALT_A)),
                abi.encodeWithSelector(SquadCodec.InvalidProtocol.selector)
            );
            SquadCodec.Action[3][2] memory legal = Support.holds();
            _rejectTurn(
                id,
                HOST,
                abi.encodeCall(arena.revealActions, (id, 1, legal[0], SALT_A)),
                abi.encodeWithSelector(Protocol.CommitmentMismatch.selector)
            );
        }
    }

    function testForeignContextsAndSquadDomainReject() public {
        SquadCodec.Action[3][2] memory actions = Support.holds();
        for (uint256 kind = 0; kind < 7; ++kind) {
            uint256 id = _battle(1);
            _turnCommit(id, 1, HOST, _foreignHash(id, kind, actions[0]));
            _turnCommit(id, 1, GUEST, _turnHash(id, 1, GUEST, actions[1], SALT_B));
            _rejectTurn(
                id,
                HOST,
                abi.encodeCall(arena.revealActions, (id, 1, actions[0], SALT_A)),
                abi.encodeWithSelector(Protocol.CommitmentMismatch.selector)
            );
        }
    }

    function _foreignHash(uint256 id, uint256 kind, SquadCodec.Action[3] memory actions)
        private
        view
        returns (bytes32)
    {
        SquadCodec.ActionInput memory input;
        input.context = _context(id);
        input.round = 1;
        input.player = HOST;
        input.rulesetId = arena.getRulesetId();
        input.actions = actions;
        if (kind == 0) ++input.context.chainId;
        if (kind == 1) input.context.arena = OBSERVER;
        if (kind == 2) ++input.context.matchId;
        if (kind == 3) ++input.round;
        if (kind == 4) input.player = GUEST;
        if (kind == 5) input.rulesetId = bytes32(0);
        return keccak256(
            abi.encode(
                kind == 6 ? SquadCodec.domain(1) : SquadCodec.domain(2),
                input.context,
                input.round,
                input.player,
                input.rulesetId,
                input.actions,
                SALT_A
            )
        );
    }

    function testPermissionsPhasesAndRoundGuards() public {
        uint256 id = _battle(1);
        SquadCodec.Action[3][2] memory actions = Support.holds();
        _rejectCall(
            HOST,
            abi.encodeCall(arena.commitActions, (999, 1, SALT_A)),
            abi.encodeWithSelector(Protocol.UnknownMatch.selector, 999)
        );
        _rejectTurn(
            id,
            OBSERVER,
            abi.encodeCall(arena.commitActions, (id, 1, SALT_A)),
            abi.encodeWithSelector(Protocol.NotPlayer.selector, OBSERVER)
        );
        _rejectTurn(
            id,
            HOST,
            abi.encodeCall(arena.commitActions, (id, 0, SALT_A)),
            abi.encodeWithSelector(Protocol.StaleRound.selector, 1, 0)
        );
        _rejectTurn(
            id,
            HOST,
            abi.encodeCall(arena.revealActions, (id, 1, actions[0], SALT_A)),
            abi.encodeWithSelector(
                Protocol.InvalidPhase.selector, Protocol.ROUND_REVEAL, Protocol.ROUND_COMMIT
            )
        );
        _rejectTurn(
            id,
            OBSERVER,
            abi.encodeCall(arena.settleRound, (id, 1)),
            abi.encodeWithSelector(
                Protocol.InvalidPhase.selector, Protocol.RESOLVABLE, Protocol.ROUND_COMMIT
            )
        );
        _commitBoth(id, actions);
        _rejectTurn(
            id,
            OBSERVER,
            abi.encodeCall(arena.revealActions, (id, 1, actions[0], SALT_A)),
            abi.encodeWithSelector(Protocol.NotPlayer.selector, OBSERVER)
        );
        _rejectTurn(
            id,
            HOST,
            abi.encodeCall(arena.revealActions, (id, 2, actions[0], SALT_A)),
            abi.encodeWithSelector(Protocol.StaleRound.selector, 1, 2)
        );
        _revealBoth(id, actions, false);
        _rejectTurn(
            id,
            OBSERVER,
            abi.encodeCall(arena.settleRound, (id, 2)),
            abi.encodeWithSelector(Protocol.StaleRound.selector, 1, 2)
        );
    }

    function testCommitAndRevealDeadlineBoundaries() public {
        for (uint256 reveal_ = 0; reveal_ < 2; ++reveal_) {
            for (uint256 first = 0; first < 2; ++first) {
                for (uint256 boundary = 0; boundary < 3; ++boundary) {
                    uint256 id = _battle(1);
                    SquadCodec.Action[3][2] memory actions = Support.holds();
                    if (reveal_ == 1) _commitBoth(id, actions);
                    if (first == 1) {
                        if (reveal_ == 1) _turnReveal(id, 1, HOST, actions[0], SALT_A);
                        else _turnCommit(id, 1, HOST, SALT_A);
                    }
                    uint64 deadline = arena.getMatch(id).phaseDeadline;
                    VM.warp(uint256(deadline) + boundary - 1);
                    address caller = first == 0 ? HOST : GUEST;
                    bytes memory payload = reveal_ == 1
                        ? abi.encodeCall(
                            arena.revealActions,
                            (id, 1, actions[first], first == 0 ? SALT_A : SALT_B)
                        )
                        : abi.encodeCall(arena.commitActions, (id, 1, SALT_A));
                    if (boundary == 2) {
                        _rejectTurn(
                            id,
                            caller,
                            payload,
                            abi.encodeWithSelector(Protocol.DeadlinePassed.selector, deadline)
                        );
                    } else {
                        VM.prank(caller);
                        // Exact deadline acceptance exercises the actual public calldata.
                        // forge-lint: disable-next-line(low-level-calls)
                        (bool accepted,) = address(arena).call(payload);
                        require(accepted, "Timely submission rejected");
                    }
                }
            }
        }
    }

    function testRevealOrderSameContextAndStateHash() public {
        uint256 id = _battle(1);
        SquadCodec.Action[3][2] memory actions = Support.allMoves(arena.getBattleState(id));
        uint256 saved = VM.snapshotState();
        _round(id, actions, false);
        bytes memory expected = _snapshot(id);
        require(VM.revertToState(saved), "Restore same match context");
        _round(id, actions, true);
        _equal(_snapshot(id), expected, "reveal.orderIndependent");
    }

    function testNextRoundDoesNotReuseActionsAndRejectsOldCalls() public {
        uint256 id = _battle(2);
        _round(id, Support.allMoves(arena.getBattleState(id)), false);
        _rejectTurn(
            id,
            OBSERVER,
            abi.encodeCall(arena.settleRound, (id, 1)),
            abi.encodeWithSelector(
                Protocol.InvalidPhase.selector, Protocol.RESOLVABLE, Protocol.ROUND_COMMIT
            )
        );
        _rejectTurn(
            id,
            HOST,
            abi.encodeCall(arena.commitActions, (id, 1, SALT_A)),
            abi.encodeWithSelector(Protocol.StaleRound.selector, 2, 1)
        );
        SquadCodec.State memory before_ = arena.getBattleState(id);
        _round(id, Support.holds(), true);
        SquadCodec.State memory after_ = arena.getBattleState(id);
        for (uint256 i = 0; i < 6; ++i) {
            require(after_.units[i].position == before_.units[i].position, "Old movement reused");
        }
    }

    function testActualSkillSequenceAndTerminalResult() public {
        uint256 id = _battle(1);
        Frame[] memory frames = new Frame[](20);
        for (uint16 round = 1; round <= 20; ++round) {
            frames[round - 1] = _round(id, _witness(round), round % 2 == 0);
            Frame memory frame = frames[round - 1];
            if (round == 4) {
                require(
                    frame.effects.coverReduced[2] == 1 && frame.effects.damageTaken[2] == 1,
                    "Cover not applied"
                );
                require(
                    frame.next.units[3].lockedRound == 5
                        && frame.effects.lockedRoundApplied[3] == 5,
                    "Lock not applied"
                );
            }
            if (round == 5) {
                require(
                    frame.effects.healed[2] == 2 && frame.effects.moved[3]
                        && frame.next.units[3].lockedRound == 0,
                    "Heal or lock expiry differs"
                );
            }
            if (round == 6) {
                require(
                    frame.effects.moved[3] && frame.effects.damageTaken[2] == 2,
                    "Unlocked Dash or Cover shot differs"
                );
            }
            if (round == 7) require(frame.effects.healed[2] == 2, "Medic healing cap differs");
            if (round == 10) {
                require(
                    !frame.next.units[2].alive && frame.next.units[2].position == 255
                        && frame.next.units[2].lockedRound == 0,
                    "Death was not normalized"
                );
                require(_checkDeadSlots(id, frame.next), "Missing dead-slot rejection");
            }
        }
        require(
            arena.getMatch(id).phase == Protocol.FINISHED && arena.getMatch(id).reason == 4,
            "Round cap did not finish"
        );
        _rejectTurn(
            id,
            HOST,
            abi.encodeCall(arena.commitActions, (id, 20, SALT_A)),
            abi.encodeWithSelector(
                Protocol.InvalidPhase.selector, Protocol.ROUND_COMMIT, Protocol.FINISHED
            )
        );
        _rejectTurn(
            id,
            OBSERVER,
            abi.encodeCall(arena.settleRound, (id, 20)),
            abi.encodeWithSelector(
                Protocol.InvalidPhase.selector, Protocol.RESOLVABLE, Protocol.FINISHED
            )
        );
        // The existing dispatcher replays these public protocol frames on both real nodes.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        VM.writeFile(
            "../.local/simulation/squad-rooms/battle-sequence.abi", VM.toString(abi.encode(frames))
        );
    }

    function testLockedSkillRejectsButNormalMoveRemainsLegal() public {
        uint256 id = _battle(1);
        for (uint16 round = 1; round <= 4; ++round) {
            _round(id, _witness(round), false);
        }
        SquadCodec.Action[3][2] memory actions = _witness(5);
        uint256 saved = VM.snapshotState();
        actions[1][0] = SquadCodec.Action(3, 255, 255, 1, 51);
        _commitBoth(id, actions);
        _turnReveal(id, 5, HOST, actions[0], SALT_A);
        _rejectTurn(
            id,
            GUEST,
            abi.encodeCall(arena.revealActions, (id, 5, actions[1], SALT_B)),
            abi.encodeWithSelector(SquadCodec.InvalidProtocol.selector)
        );
        require(VM.revertToState(saved), "Restore original commitments");
        _round(id, _witness(5), true);
    }

    function testFuzzReachableRounds(uint256 seed, bool guestFirst) public {
        // The remainder restricts the selected map to the three released IDs.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint8 mapId = uint8(1 + seed % 3);
        uint8[3] memory a = Support.lineup(seed % 60);
        uint8[3] memory b = Support.lineup((seed >> 8) % 60);
        uint256 id = _ready(mapId, a, b, SALT_A, SALT_B);
        _reveal(id, HOST, a, SALT_A);
        _reveal(id, GUEST, b, SALT_B);
        for (uint256 index = 0; index < 3; ++index) {
            SquadCodec.State memory state = arena.getBattleState(id);
            if (state.outcome != 0) break;
            SquadCodec.Action[3][2] memory actions = Support.generate(state, seed);
            seed = Support.nextSeed(seed);
            _round(id, actions, guestFirst);
        }
    }

    function testCompleteGamesAcrossMaps() public {
        bool points = false;
        bool roundCap = false;
        for (uint8 mapId = 1; mapId <= 3; ++mapId) {
            (bool scored, bool capped) = _fullGame(mapId);
            points = points || scored;
            roundCap = roundCap || capped;
        }
        require(points && roundCap, "Missing complete points/round-cap games");
    }

    function _readGame(uint8 mapId) private view returns (GameOrders memory) {
        string memory name = string.concat(
            "../.local/simulation/squad-rooms/battle-game-", VM.toString(uint256(mapId)), ".abi"
        );
        // The dispatcher prepares these frames from the existing validated pure-rule corpus.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        bytes memory encoded = VM.readFileBinary(name);
        return abi.decode(encoded, (GameOrders));
    }

    function _fullGame(uint8 mapId) private returns (bool points, bool roundCap) {
        GameOrders memory game = _readGame(mapId);
        require(game.rounds.length > 0 && game.rounds.length <= 20, "Missing complete map game");
        uint256 id = _ready(mapId, game.a, game.b, SALT_A, SALT_B);
        _reveal(id, HOST, game.a, SALT_A);
        _reveal(id, GUEST, game.b, SALT_B);
        for (uint256 step = 0; step < game.rounds.length; ++step) {
            SquadCodec.Action[3][2] memory actions =
                abi.decode(game.rounds[step], (SquadCodec.Action[3][2]));
            _round(id, actions, step % 2 == 0);
        }
        require(arena.getMatch(id).phase == Protocol.FINISHED, "Generated match did not finish");
        points = arena.getMatch(id).reason == 3;
        roundCap = arena.getMatch(id).reason == 4;
    }

    function _checkDeadSlots(uint256 id, SquadCodec.State memory state) private returns (bool) {
        for (uint256 unitId = 0; unitId < 6; ++unitId) {
            if (!state.units[unitId].alive) {
                this.rejectDeadSlot(id, arena.getMatch(id).activeRound, unitId);
                return true;
            }
        }
        return false;
    }

    function rejectDeadSlot(uint256 id, uint16 round, uint256 unitId) external {
        uint256 saved = VM.snapshotState();
        SquadCodec.Action[3][2] memory invalid = Support.holds();
        invalid[unitId / 3][unitId % 3] = SquadCodec.Action(2, 0, 255, 0, 0);
        _commitBoth(id, invalid);
        address player = unitId < 3 ? HOST : GUEST;
        bytes32 salt = unitId < 3 ? SALT_A : SALT_B;
        bytes memory payload =
            abi.encodeCall(arena.revealActions, (id, round, invalid[unitId / 3], salt));
        bytes memory reason = abi.encodeWithSelector(SquadCodec.InvalidProtocol.selector);
        _rejectTurn(id, player, payload, reason);
        require(VM.revertToState(saved), "Restore dead-slot rejection fixture");
    }
}

contract SquadTurnGasTest is SquadBattleFixture {
    function testGasFirstCommit() public {
        _commitGas(false);
    }

    function testGasSecondCommit() public {
        _commitGas(true);
    }

    function testGasFirstReveal() public {
        _revealGas(false);
    }

    function testGasSecondReveal() public {
        _revealGas(true);
    }

    function testGasSixMovesSettlement() public {
        VM.pauseGasMetering();
        uint256 id = _battle(3);
        SquadCodec.Action[3][2] memory actions = Support.allMoves(arena.getBattleState(id));
        _commitBoth(id, actions);
        _revealBoth(id, actions, false);
        _measure(
            id, OBSERVER, abi.encodeCall(arena.settleRound, (id, 1)), "settle-moves", 1_500_000
        );
    }

    function testGasCoverLockSettlement() public {
        _witnessGas(4, "settle-cover-lock");
    }

    function testGasHealingSettlement() public {
        _witnessGas(5, "settle-healing");
    }

    function testGasTerminalSettlement() public {
        _witnessGas(20, "settle-terminal");
    }

    function _commitGas(bool second) private {
        VM.pauseGasMetering();
        uint256 id = _battle(1);
        if (second) _turnCommit(id, 1, HOST, SALT_A);
        _measure(
            id,
            second ? GUEST : HOST,
            abi.encodeCall(arena.commitActions, (id, 1, SALT_B)),
            second ? "commit-second" : "commit-first",
            100_000
        );
    }

    function _revealGas(bool second) private {
        VM.pauseGasMetering();
        uint256 id = _battle(1);
        SquadCodec.Action[3][2] memory actions = _witness(1);
        _commitBoth(id, actions);
        if (second) _turnReveal(id, 1, HOST, actions[0], SALT_A);
        _measure(
            id,
            second ? GUEST : HOST,
            abi.encodeCall(
                arena.revealActions, (id, 1, actions[second ? 1 : 0], second ? SALT_B : SALT_A)
            ),
            second ? "reveal-second" : "reveal-first",
            250_000
        );
    }

    function _witnessGas(uint16 at, string memory name) private {
        VM.pauseGasMetering();
        uint256 id = _battle(1);
        for (uint16 round = 1; round < at; ++round) {
            _round(id, _witness(round), false);
        }
        SquadCodec.Action[3][2] memory actions = _witness(at);
        _commitBoth(id, actions);
        _revealBoth(id, actions, false);
        _measure(id, OBSERVER, abi.encodeCall(arena.settleRound, (id, at)), name, 1_500_000);
    }

    function _measure(
        uint256,
        address player,
        bytes memory payload,
        string memory name,
        uint256 target
    ) private {
        VM.resumeGasMetering();
        VM.prank(player);
        uint256 before_ = gasleft();
        // Isolation includes the intrinsic calldata component, as in the existing Reveal samples.
        // forge-lint: disable-next-line(low-level-calls)
        (bool accepted, bytes memory reason) = address(arena).call(payload);
        uint256 used = before_ - gasleft();
        VM.pauseGasMetering();
        require(accepted, string(reason));
        // Preserve every sample before the dispatcher collects all budget misses.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        VM.writeFile(
            string.concat("../.local/safety/squad-turn-gas-", name, ".json"),
            string.concat(
                '{"name":"',
                name,
                '","gasUsed":',
                VM.toString(used),
                ',"target":',
                VM.toString(target),
                "}"
            )
        );
    }
}
// forge-lint: disable-end(multi-contract-file,literal-instead-of-constant,calls-loop,require-revert-in-loop)
