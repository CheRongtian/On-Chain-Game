// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadBattleFixture } from "./SquadBattle.t.sol";
import { SquadCodec } from "../src/SquadCodec.sol";
import { SquadProtocol as Protocol } from "../src/SquadProtocol.sol";
import { SquadRules } from "../src/SquadRules.sol";
import { SquadSafetySupport as Support } from "./SquadSafetySupport.sol";
import { ISquadEvents } from "../src/ISquadArena.sol";
import { IDevVm } from "../script/IDevVm.sol";

// Fixed stage/mask matrices and raw calls verify exact rollback and inclusive boundaries.
// forge-lint: disable-start(multi-contract-file,literal-instead-of-constant,calls-loop,require-revert-in-loop)
abstract contract SquadTimeoutFixture is SquadBattleFixture {
    function _waiting(bool joined) internal returns (uint256 id) {
        VM.prank(HOST);
        id = arena.createMatch(1);
        if (joined) {
            VM.prank(GUEST);
            arena.joinMatch(id);
        }
    }

    // Keep the four timed phases and submission masks together in this fixture matrix.
    // forge-lint: disable-next-item(cyclomatic-complexity)
    function _stage(uint8 phase, uint8 mask) internal returns (uint256 id) {
        SquadCodec.Action[3][2] memory actions = Support.holds();
        if (phase == Protocol.SQUAD_COMMIT) {
            id = _open(1);
        } else if (phase == Protocol.SQUAD_REVEAL) {
            id = _ready(1, _a(), _b(), SALT_A, SALT_B);
        } else {
            id = _battle(1);
            if (phase == Protocol.ROUND_REVEAL) _commitBoth(id, actions);
        }
        for (uint8 side = 0; side < 2; ++side) {
            if ((mask & (uint8(1) << side)) == 0) continue;
            address player = side == 0 ? HOST : GUEST;
            bytes32 salt = side == 0 ? SALT_A : SALT_B;
            if (phase == Protocol.SQUAD_COMMIT) {
                _commit(id, player, _value(_input(id, player, side == 0 ? _a() : _b(), salt)));
            } else if (phase == Protocol.SQUAD_REVEAL) {
                _reveal(id, player, side == 0 ? _a() : _b(), salt);
            } else if (phase == Protocol.ROUND_COMMIT) {
                _turnCommit(id, 1, player, _turnHash(id, 1, player, actions[side], salt));
            } else {
                _turnReveal(id, 1, player, actions[side], salt);
            }
        }
    }

    function _reason(uint8 phase) internal pure returns (uint8) {
        return phase == Protocol.SQUAD_COMMIT
            ? 7
            : phase == Protocol.SQUAD_REVEAL ? 8 : phase == Protocol.ROUND_COMMIT ? 5 : 6;
    }

    function _timeout(uint256 id, uint8 phase, uint8 mask, address caller) internal {
        SquadCodec.MatchSummary memory expectedSummary = arena.getMatch(id);
        SquadCodec.State memory expectedState = arena.getBattleState(id);
        bytes memory squad = abi.encode(arena.getSquadStatus(id));
        bytes memory turn = abi.encode(arena.getRoundStatus(id));
        uint8 outcome = mask == 0 ? 3 : mask == 1 ? 1 : 2;
        expectedState.outcome = outcome;
        expectedState.reason = _reason(phase);
        expectedSummary.phase = Protocol.FINISHED;
        expectedSummary.phaseDeadline = 0;
        expectedSummary.outcome = outcome;
        expectedSummary.reason = expectedState.reason;
        expectedSummary.stateHash = SquadRules.hashState(_context(id), expectedState);
        uint64 deadline = arena.getMatch(id).phaseDeadline;
        VM.warp(uint256(deadline) + 1);
        VM.recordLogs();
        VM.prank(caller);
        arena.advanceExpiredPhase(id, expectedSummary.activeRound, phase);
        IDevVm.Log[] memory logs = VM.getRecordedLogs();
        _equal(abi.encode(arena.getMatch(id)), abi.encode(expectedSummary), "timeout.summary");
        _equal(abi.encode(arena.getBattleState(id)), abi.encode(expectedState), "timeout.state");
        _equal(abi.encode(arena.getSquadStatus(id)), squad, "timeout.squad");
        _equal(abi.encode(arena.getRoundStatus(id)), turn, "timeout.turn");
        require(logs.length == 2, "Timeout emitted battle/start events");
        require(logs[0].topics[0] == ISquadEvents.PhaseAdvanced.selector, "Timeout phase event");
        _equal(logs[0].data, abi.encode(phase, Protocol.FINISHED, uint64(0)), "timeout.phase.data");
        require(logs[1].topics[0] == ISquadEvents.MatchFinished.selector, "Timeout finish event");
        require(logs[1].topics[1] == bytes32(id), "Timeout match ID");
        address winner = mask == 0 ? address(0) : mask == 1 ? HOST : GUEST;
        require(logs[1].topics[2] == bytes32(uint256(uint160(winner))), "Timeout winner");
        _equal(
            logs[1].data,
            abi.encode(
                expectedSummary.activeRound,
                expectedState.battleStarted,
                expectedState.completedRound,
                outcome,
                expectedState.reason,
                expectedSummary.stateHash
            ),
            "timeout.finish.data"
        );
    }
}

contract SquadTimeoutTest is SquadTimeoutFixture {
    function testWaitingCreatorCancellationBeforeAfterDeadlineAndWithGuest() public {
        for (uint256 joined = 0; joined < 2; ++joined) {
            for (uint256 expired = 0; expired < 2; ++expired) {
                uint256 id = _waiting(joined == 1);
                _rejectTurn(
                    id,
                    OBSERVER,
                    abi.encodeCall(arena.cancelWaitingMatch, (id)),
                    abi.encodeWithSelector(Protocol.NotCreator.selector, OBSERVER)
                );
                if (expired == 1) VM.warp(uint256(arena.getMatch(id).joinDeadline) + 1);
                bytes memory before_ = abi.encode(arena.getBattleState(id));
                VM.recordLogs();
                VM.prank(HOST);
                arena.cancelWaitingMatch(id);
                IDevVm.Log[] memory logs = VM.getRecordedLogs();
                require(
                    logs.length == 1 && logs[0].topics[0] == ISquadEvents.PhaseAdvanced.selector,
                    "Cancel event"
                );
                _equal(
                    logs[0].data,
                    abi.encode(Protocol.WAITING, Protocol.CANCELLED, uint64(0)),
                    "cancel.phase"
                );
                require(
                    arena.getMatch(id).phase == Protocol.CANCELLED
                        && arena.getMatch(id).outcome == 0,
                    "Cancel result"
                );
                _equal(abi.encode(arena.getBattleState(id)), before_, "cancel.battle");
                _rejectTurn(
                    id,
                    GUEST,
                    abi.encodeCall(arena.joinMatch, (id)),
                    abi.encodeWithSelector(
                        Protocol.InvalidPhase.selector, Protocol.WAITING, Protocol.CANCELLED
                    )
                );
                _rejectTurn(
                    id,
                    HOST,
                    abi.encodeCall(arena.startMatch, (id)),
                    abi.encodeWithSelector(
                        Protocol.InvalidPhase.selector, Protocol.WAITING, Protocol.CANCELLED
                    )
                );
            }
        }
    }

    function testWaitingExpiryBeforeAtAfterAndGuestMetadata() public {
        for (uint256 joined = 0; joined < 2; ++joined) {
            for (uint256 boundary = 0; boundary < 3; ++boundary) {
                uint256 id = _waiting(joined == 1);
                SquadCodec.MatchSummary memory expected = arena.getMatch(id);
                require(
                    expected.joinDeadline == VM.getBlockTimestamp() + 86400, "Frozen waiting window"
                );
                VM.warp(uint256(expected.joinDeadline) + boundary - 1);
                if (boundary < 2) {
                    _rejectTurn(
                        id,
                        OBSERVER,
                        abi.encodeCall(arena.expireWaitingMatch, (id)),
                        abi.encodeWithSelector(
                            Protocol.DeadlineNotPassed.selector, expected.joinDeadline
                        )
                    );
                } else {
                    bytes memory before_ = abi.encode(arena.getBattleState(id));
                    VM.recordLogs();
                    VM.prank(OBSERVER);
                    arena.expireWaitingMatch(id);
                    require(VM.getRecordedLogs().length == 1, "Expiry emitted match result");
                    expected.phase = Protocol.EXPIRED;
                    _equal(abi.encode(arena.getMatch(id)), abi.encode(expected), "expiry.summary");
                    _equal(abi.encode(arena.getBattleState(id)), before_, "expiry.battle");
                    _rejectTurn(
                        id,
                        HOST,
                        abi.encodeCall(arena.startMatch, (id)),
                        abi.encodeWithSelector(
                            Protocol.InvalidPhase.selector, Protocol.WAITING, Protocol.EXPIRED
                        )
                    );
                }
            }
        }
    }

    function testAllFourTimeoutsAndSoleBilateralDefaults() public {
        for (uint8 phase = 2; phase <= 5; ++phase) {
            for (uint8 mask = 0; mask < 3; ++mask) {
                uint256 id = _stage(phase, mask);
                _timeout(id, phase, mask, mask == 0 ? OBSERVER : mask == 1 ? GUEST : HOST);
            }
        }
    }

    function testTimeoutInclusiveDeadlineBoundaries() public {
        for (uint8 phase = 2; phase <= 5; ++phase) {
            for (uint256 boundary = 0; boundary < 3; ++boundary) {
                uint256 id = _stage(phase, 1);
                SquadCodec.MatchSummary memory summary = arena.getMatch(id);
                VM.warp(uint256(summary.phaseDeadline) + boundary - 1);
                if (boundary < 2) {
                    _rejectTurn(
                        id,
                        OBSERVER,
                        abi.encodeCall(arena.advanceExpiredPhase, (id, summary.activeRound, phase)),
                        abi.encodeWithSelector(
                            Protocol.DeadlineNotPassed.selector, summary.phaseDeadline
                        )
                    );
                } else {
                    _timeout(id, phase, 1, OBSERVER);
                }
            }
        }
    }

    function testUnknownMatchesInvalidPhasesAndStaleRounds() public {
        _rejectCall(
            OBSERVER,
            abi.encodeCall(arena.advanceExpiredPhase, (999, 0, 2)),
            abi.encodeWithSelector(Protocol.UnknownMatch.selector, 999)
        );
        _rejectCall(
            HOST,
            abi.encodeCall(arena.cancelWaitingMatch, (999)),
            abi.encodeWithSelector(Protocol.UnknownMatch.selector, 999)
        );
        _rejectCall(
            OBSERVER,
            abi.encodeCall(arena.expireWaitingMatch, (999)),
            abi.encodeWithSelector(Protocol.UnknownMatch.selector, 999)
        );
        uint256 id = _stage(2, 0);
        _rejectTurn(
            id,
            OBSERVER,
            abi.encodeCall(arena.advanceExpiredPhase, (id, 0, 1)),
            abi.encodeWithSelector(Protocol.InvalidTimeoutPhase.selector, 1)
        );
        _rejectTurn(
            id,
            OBSERVER,
            abi.encodeCall(arena.advanceExpiredPhase, (id, 0, 6)),
            abi.encodeWithSelector(Protocol.InvalidTimeoutPhase.selector, 6)
        );
        _rejectTurn(
            id,
            OBSERVER,
            abi.encodeCall(arena.advanceExpiredPhase, (id, 0, 255)),
            abi.encodeWithSelector(Protocol.InvalidTimeoutPhase.selector, 255)
        );
        _rejectTurn(
            id,
            OBSERVER,
            abi.encodeCall(arena.advanceExpiredPhase, (id, 1, 2)),
            abi.encodeWithSelector(Protocol.StaleRound.selector, 0, 1)
        );
        _rejectTurn(
            id,
            OBSERVER,
            abi.encodeCall(arena.advanceExpiredPhase, (id, 0, 3)),
            abi.encodeWithSelector(Protocol.InvalidPhase.selector, 3, 2)
        );
    }

    function testEarlyCompletionInvalidatesOldTimeouts() public {
        uint256 id = _ready(1, _a(), _b(), SALT_A, SALT_B);
        _rejectTurn(
            id,
            OBSERVER,
            abi.encodeCall(arena.advanceExpiredPhase, (id, 0, 2)),
            abi.encodeWithSelector(Protocol.InvalidPhase.selector, 2, 3)
        );
        _reveal(id, HOST, _a(), SALT_A);
        _reveal(id, GUEST, _b(), SALT_B);
        _rejectTurn(
            id,
            OBSERVER,
            abi.encodeCall(arena.advanceExpiredPhase, (id, 0, 3)),
            abi.encodeWithSelector(Protocol.InvalidPhase.selector, 3, 4)
        );
        SquadCodec.Action[3][2] memory actions = Support.holds();
        _commitBoth(id, actions);
        _rejectTurn(
            id,
            OBSERVER,
            abi.encodeCall(arena.advanceExpiredPhase, (id, 1, 4)),
            abi.encodeWithSelector(Protocol.InvalidPhase.selector, 4, 5)
        );
        _revealBoth(id, actions, true);
        _rejectTurn(
            id,
            OBSERVER,
            abi.encodeCall(arena.advanceExpiredPhase, (id, 1, 5)),
            abi.encodeWithSelector(Protocol.InvalidPhase.selector, 5, 6)
        );
    }

    function testLateSubmissionsAndTerminalImmutability() public {
        for (uint8 phase = 2; phase <= 5; ++phase) {
            uint256 id = _stage(phase, 1);
            uint16 round = arena.getMatch(id).activeRound;
            _timeout(id, phase, 1, GUEST);
            _rejectTurn(
                id,
                OBSERVER,
                abi.encodeCall(arena.advanceExpiredPhase, (id, round, phase)),
                abi.encodeWithSelector(Protocol.InvalidPhase.selector, phase, Protocol.FINISHED)
            );
            bytes memory payload;
            if (phase == 2) {
                payload = abi.encodeCall(arena.commitSquad, (id, SALT_B));
            } else if (phase == 3) {
                payload = abi.encodeCall(arena.revealSquad, (id, _b(), SALT_B));
            } else if (phase == 4) {
                payload = abi.encodeCall(arena.commitActions, (id, round, SALT_B));
            } else {
                SquadCodec.Action[3][2] memory actions = Support.holds();
                payload = abi.encodeCall(arena.revealActions, (id, round, actions[1], SALT_B));
            }
            _rejectTurn(
                id,
                GUEST,
                payload,
                abi.encodeWithSelector(Protocol.InvalidPhase.selector, phase, Protocol.FINISHED)
            );
            _rejectTurn(
                id,
                OBSERVER,
                abi.encodeCall(arena.settleRound, (id, round)),
                abi.encodeWithSelector(
                    Protocol.InvalidPhase.selector, Protocol.RESOLVABLE, Protocol.FINISHED
                )
            );
            _rejectTurn(
                id,
                HOST,
                abi.encodeCall(arena.cancelWaitingMatch, (id)),
                abi.encodeWithSelector(
                    Protocol.InvalidPhase.selector, Protocol.WAITING, Protocol.FINISHED
                )
            );
        }
    }

    function testInvalidRevealStillCountsAsMissing() public {
        uint256 id = _stage(3, 2);
        _reject(
            id, HOST, _a(), SALT_B, abi.encodeWithSelector(Protocol.CommitmentMismatch.selector)
        );
        _timeout(id, 3, 2, HOST);
        id = _stage(5, 2);
        SquadCodec.Action[3][2] memory actions = Support.holds();
        _rejectTurn(
            id,
            HOST,
            abi.encodeCall(arena.revealActions, (id, 1, actions[0], SALT_B)),
            abi.encodeWithSelector(Protocol.CommitmentMismatch.selector)
        );
        _timeout(id, 5, 2, HOST);
    }

    function testBattleTimeoutPreservesResourcesCompletedRoundAndLocks() public {
        uint256 id = _battle(1);
        for (uint16 round = 1; round <= 4; ++round) {
            _round(id, _witness(round), false);
        }
        require(
            arena.getBattleState(id).completedRound == 4
                && arena.getBattleState(id).units[3].lockedRound == 5,
            "Missing noninitial lock state"
        );
        _timeout(id, 4, 0, OBSERVER);
        require(
            arena.getMatch(id).activeRound == 5 && arena.getBattleState(id).completedRound == 4,
            "Timeout completed an unplayed round"
        );
    }

    function testResolvableStaysPublicAndOldRoundCannotForfeitNextRound() public {
        uint256 id = _stage(5, 0);
        SquadCodec.Action[3][2] memory actions = Support.holds();
        _revealBoth(id, actions, false);
        VM.warp(VM.getBlockTimestamp() + 86400);
        _rejectTurn(
            id,
            OBSERVER,
            abi.encodeCall(arena.advanceExpiredPhase, (id, 1, 6)),
            abi.encodeWithSelector(Protocol.InvalidTimeoutPhase.selector, 6)
        );
        VM.prank(OBSERVER);
        arena.settleRound(id, 1);
        require(arena.getMatch(id).activeRound == 2, "Public settlement did not advance");
        _rejectTurn(
            id,
            GUEST,
            abi.encodeCall(arena.advanceExpiredPhase, (id, 1, 4)),
            abi.encodeWithSelector(Protocol.StaleRound.selector, 2, 1)
        );
        _rejectTurn(
            id,
            HOST,
            abi.encodeCall(arena.settleRound, (id, 1)),
            abi.encodeWithSelector(Protocol.InvalidPhase.selector, 6, 4)
        );
    }

    function testCompetingCancelExpiryAndTimeoutOrdersAreOnceOnly() public {
        for (uint256 first = 0; first < 2; ++first) {
            uint256 id = _waiting(true);
            VM.warp(uint256(arena.getMatch(id).joinDeadline) + 1);
            if (first == 0) {
                VM.prank(HOST);
                arena.cancelWaitingMatch(id);
                _rejectTurn(
                    id,
                    OBSERVER,
                    abi.encodeCall(arena.expireWaitingMatch, (id)),
                    abi.encodeWithSelector(Protocol.InvalidPhase.selector, 1, 8)
                );
            } else {
                VM.prank(OBSERVER);
                arena.expireWaitingMatch(id);
                _rejectTurn(
                    id,
                    HOST,
                    abi.encodeCall(arena.cancelWaitingMatch, (id)),
                    abi.encodeWithSelector(Protocol.InvalidPhase.selector, 1, 9)
                );
            }
            id = _stage(2, 2);
            _timeout(id, 2, 2, first == 0 ? HOST : OBSERVER);
            _rejectTurn(
                id,
                first == 0 ? OBSERVER : HOST,
                abi.encodeCall(arena.advanceExpiredPhase, (id, 0, 2)),
                abi.encodeWithSelector(Protocol.InvalidPhase.selector, 2, 7)
            );
        }
    }

    function testFuzzDefaultWinnerIsIndependentOfCaller(
        uint8 inputPhase,
        uint8 inputMask,
        bool missingCaller
    ) public {
        uint8 phase = 2 + inputPhase % 4;
        uint8 mask = inputMask % 3;
        uint256 id = _stage(phase, mask);
        address caller = missingCaller ? (mask == 1 ? GUEST : HOST) : OBSERVER;
        _timeout(id, phase, mask, caller);
    }
}

contract SquadTimeoutGasTest is SquadTimeoutFixture {
    function testGasCancel() public {
        _waitingGas(false);
    }

    function testGasExpiry() public {
        _waitingGas(true);
    }

    function testGasSquadCommitTimeout() public {
        _timeoutGas(2, "squad-commit");
    }

    function testGasSquadRevealTimeout() public {
        _timeoutGas(3, "squad-reveal");
    }

    function testGasRoundCommitTimeout() public {
        _timeoutGas(4, "round-commit");
    }

    function testGasRoundRevealTimeout() public {
        _timeoutGas(5, "round-reveal");
    }

    function _waitingGas(bool expired) private {
        VM.pauseGasMetering();
        uint256 id = _waiting(false);
        if (expired) VM.warp(uint256(arena.getMatch(id).joinDeadline) + 1);
        _measureExpiry(
            expired ? "expiry" : "cancel",
            expired ? OBSERVER : HOST,
            expired
                ? abi.encodeCall(arena.expireWaitingMatch, (id))
                : abi.encodeCall(arena.cancelWaitingMatch, (id))
        );
    }

    function _timeoutGas(uint8 phase, string memory name) private {
        VM.pauseGasMetering();
        uint256 id = _stage(phase, 1);
        SquadCodec.MatchSummary memory summary = arena.getMatch(id);
        VM.warp(uint256(summary.phaseDeadline) + 1);
        _measureExpiry(
            name,
            OBSERVER,
            abi.encodeCall(arena.advanceExpiredPhase, (id, summary.activeRound, phase))
        );
    }

    function _measureExpiry(string memory name, address caller, bytes memory payload) private {
        VM.resumeGasMetering();
        VM.prank(caller);
        uint256 before_ = gasleft();
        // Measure the real external method; isolation includes intrinsic Gas.
        // forge-lint: disable-next-line(low-level-calls)
        (bool ok, bytes memory reason) = address(arena).call(payload);
        uint256 used = before_ - gasleft();
        VM.pauseGasMetering();
        require(ok, string(reason));
        // No new engineering budget is invented for these operations; retain the measured value.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        VM.writeFile(
            string.concat("../.local/safety/squad-timeout-gas-", name, ".json"),
            string.concat('{"name":"', name, '","gasUsed":', VM.toString(used), "}")
        );
    }
}
// forge-lint: disable-end(multi-contract-file,literal-instead-of-constant,calls-loop,require-revert-in-loop)
