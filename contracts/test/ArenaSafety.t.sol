// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { Arena } from "../src/Arena.sol";
import { GameTypes } from "../src/GameTypes.sol";
import { GameHash } from "../src/GameHash.sol";
import { BattleResolver } from "../src/BattleResolver.sol";
import { IArena } from "../src/IArena.sol";
import { SafetySupport, SafetyActions } from "./SafetySupport.sol";
import { ArenaHandler } from "./ArenaHandler.sol";

// The invariant configuration is colocated with the protocol tests it drives.
// forge-lint: disable-next-line(multi-contract-file)
contract ArenaInvariantTest {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }
    ArenaHandler private handler;

    function setUp() public {
        handler = new ArenaHandler(new Arena());
        // Exercise a real round before random sequences so the settlement checks are not vacuous.
        // Four local operations prove that the handler reaches a real settlement.
        // forge-lint: disable-next-item(calls-loop)
        for (uint256 index = 0; index < 4; ++index) {
            handler.step(10);
        }
        require(handler.successfulSettlements() == 1, "Handler never reached settlement");
    }

    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() external view returns (FuzzSelector[] memory targets) {
        targets = new FuzzSelector[](1);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = ArenaHandler.step.selector;
        targets[0] = FuzzSelector({ addr: address(handler), selectors: selectors });
    }

    function invariantProtocolState() public view {
        handler.check();
    }
}

// Inline boundary values document specific malformed inputs and exact deadline cases.
// forge-lint: disable-next-item(multi-contract-file, literal-instead-of-constant)
contract ArenaSafetyTest is SafetySupport {
    function setUp() public {
        arena = new Arena();
    }

    function testHostStartsAfterJoin() public {
        VM.prank(HOST);
        uint256 id = arena.createMatch(1);
        rejected(id, HOST, abi.encodeCall(Arena.startMatch, (id)), IArena.OpponentMissing.selector);
        VM.prank(GUEST);
        arena.joinMatch(id);
        require(arena.getMatch(id).phase == GameTypes.Phase.Lobby, "Join started game");
        rejected(id, GUEST, abi.encodeCall(Arena.startMatch, (id)), IArena.NotCreator.selector);
        VM.prank(HOST);
        arena.startMatch(id);
        require(arena.getMatch(id).phase == GameTypes.Phase.Commit, "Host cannot start");
    }

    function testOnlyPlayersMaySubmit() public {
        uint256 id = room();
        rejected(
            id,
            OBSERVER,
            abi.encodeCall(Arena.commitActions, (id, uint8(1), SALT_A)),
            IArena.NotPlayer.selector
        );
        commit(id, HOST, SafetyActions.holds(), SALT_A);
        commit(id, GUEST, SafetyActions.holds(), SALT_B);
        rejected(
            id,
            OBSERVER,
            abi.encodeCall(Arena.revealActions, (id, uint8(1), SafetyActions.holds(), SALT_A)),
            IArena.NotPlayer.selector
        );
    }

    function testFuzzCommitmentContextCannotReplay(uint256 seed) public {
        uint256 id = room();
        GameTypes.Action[3] memory orders = SafetyActions.holds();
        GameTypes.MatchContext memory wrong = context(id);
        address player = HOST;
        uint8 round = 1;
        bytes32 salt = SALT_A;
        uint256 dimension = seed % 7;
        if (dimension == 0) wrong.chainId ^= 1;
        else if (dimension == 1) wrong.arena = address(0xDEAD);
        else if (dimension == 2) ++wrong.matchId;
        else if (dimension == 3) player = GUEST;
        else if (dimension == 4) ++round;
        else if (dimension == 5) salt = SALT_B;
        else orders[0].kind = GameTypes.ActionKind.Shield;
        bytes32 value = GameHash.actionCommitment(wrong, round, player, orders, salt);
        VM.prank(HOST);
        arena.commitActions(id, 1, value);
        commit(id, GUEST, SafetyActions.holds(), SALT_B);
        rejected(
            id,
            HOST,
            abi.encodeCall(Arena.revealActions, (id, uint8(1), SafetyActions.holds(), SALT_A)),
            IArena.CommitmentMismatch.selector
        );
        require(!arena.getRoundStatus(id).revealed[0], "Failed replay consumed reveal");
    }

    function testFuzzInvalidOrdersDoNotConsumeReveal(uint8 choice) public {
        uint256 id = room();
        GameTypes.Action[3] memory orders = SafetyActions.holds();
        bytes4 expected;
        bool canonical = true;
        uint256 variant = choice % 7;
        if (variant == 0) {
            orders[0].targetCell = 0;
            canonical = false;
            expected = IArena.InvalidActionEncoding.selector;
        } else if (variant == 1) {
            orders[0].kind = GameTypes.ActionKind.PowerShot;
            orders[0].targetCell = 16;
            expected = IArena.InvalidAction.selector;
        } else if (variant == 2) {
            orders[0].kind = GameTypes.ActionKind.Move;
            orders[0].pathLength = 1;
            orders[0].path[0] = 17;
            expected = IArena.InvalidPath.selector;
        } else if (variant == 3) {
            orders[1].kind = GameTypes.ActionKind.Move;
            orders[1].pathLength = 2;
            orders[1].path[0] = 16;
            orders[1].path[1] = 8;
            expected = IArena.InvalidPath.selector;
        } else if (variant == 4) {
            orders[0].kind = GameTypes.ActionKind.Shield;
            orders[1].kind = GameTypes.ActionKind.PowerShot;
            orders[1].targetCell = 25;
            expected = IArena.InsufficientEnergy.selector;
        } else if (variant == 5) {
            orders[1].kind = GameTypes.ActionKind.Attack;
            orders[1].targetCell = 63;
            expected = IArena.InvalidTarget.selector;
        } else {
            orders[0].path[3] = 1;
            canonical = false;
            expected = IArena.InvalidActionEncoding.selector;
        }
        bytes32 value =
            canonical ? GameHash.actionCommitment(context(id), 1, HOST, orders, SALT_A) : SALT_A;
        VM.prank(HOST);
        arena.commitActions(id, 1, value);
        commit(id, GUEST, SafetyActions.holds(), SALT_B);
        rejected(
            id, HOST, abi.encodeCall(Arena.revealActions, (id, uint8(1), orders, SALT_A)), expected
        );
    }

    function testFuzzDeadlineBoundaries(uint8 offset, bool revealPhase) public {
        uint256 id = room();
        GameTypes.Action[3] memory orders = SafetyActions.holds();
        if (revealPhase) {
            commit(id, HOST, orders, SALT_A);
            commit(id, GUEST, orders, SALT_B);
        }
        GameTypes.MatchSummary memory summary = arena.getMatch(id);
        uint256 boundary = offset % 3;
        VM.warp(uint256(summary.phaseDeadline) - 1 + boundary);
        bytes memory payload = revealPhase
            ? abi.encodeCall(Arena.revealActions, (id, uint8(1), orders, SALT_A))
            : abi.encodeCall(
                Arena.commitActions,
                (id, uint8(1), GameHash.actionCommitment(context(id), 1, HOST, orders, SALT_A))
            );
        if (boundary < 2) {
            rejected(
                id,
                OBSERVER,
                abi.encodeCall(Arena.advanceExpiredPhase, (id, uint8(1), summary.phase)),
                IArena.DeadlineNotPassed.selector
            );
            VM.prank(HOST);
            // The chosen payload tests either Commit or Reveal and its success is asserted.
            // forge-lint: disable-next-line(low-level-calls)
            (bool ok,) = address(arena).call(payload);
            require(ok, "On-time submission rejected");
        } else {
            rejected(id, HOST, payload, IArena.DeadlinePassed.selector);
            arena.advanceExpiredPhase(id, 1, summary.phase);
            require(
                arena.getMatch(id).outcome == GameTypes.Outcome.Draw,
                "Missing submissions did not draw"
            );
        }
    }

    // All three deadline boundaries must call and assert against the local Arena.
    // forge-lint: disable-next-item(calls-loop)
    function testWaitingDeadlineBoundaries() public {
        for (uint256 offset = 0; offset < 3; ++offset) {
            VM.prank(HOST);
            uint256 id = arena.createMatch(1);
            uint256 deadline = arena.getMatch(id).joinDeadline;
            VM.warp(deadline - 1 + offset);
            if (offset < 2) {
                rejected(
                    id,
                    OBSERVER,
                    abi.encodeCall(Arena.expireWaitingMatch, (id)),
                    IArena.DeadlineNotPassed.selector
                );
                VM.prank(GUEST);
                arena.joinMatch(id);
                VM.prank(HOST);
                arena.startMatch(id);
            } else {
                rejected(
                    id, GUEST, abi.encodeCall(Arena.joinMatch, (id)), IArena.DeadlinePassed.selector
                );
                arena.expireWaitingMatch(id);
                rejected(
                    id, HOST, abi.encodeCall(Arena.startMatch, (id)), IArena.InvalidPhase.selector
                );
            }
        }
    }

    // Six bounded withholding cases require separate transactions and outcome assertions.
    // forge-lint: disable-next-item(calls-loop, require-revert-in-loop)
    function testAllTimeoutOutcomes() public {
        GameTypes.Action[3] memory orders = SafetyActions.holds();
        for (uint256 variant = 0; variant < 6; ++variant) {
            uint256 id = room();
            if (variant >= 3) {
                commit(id, HOST, orders, SALT_A);
                commit(id, GUEST, orders, SALT_B);
            }
            uint256 submitted = variant % 3;
            if (submitted != 0) {
                address player = submitted == 1 ? HOST : GUEST;
                bytes32 salt = submitted == 1 ? SALT_A : SALT_B;
                if (variant >= 3) reveal(id, player, orders, salt);
                else commit(id, player, orders, salt);
            }
            GameTypes.MatchSummary memory summary = arena.getMatch(id);
            VM.warp(uint256(summary.phaseDeadline) + 1);
            arena.advanceExpiredPhase(id, 1, summary.phase);
            GameTypes.Outcome expected = submitted == 0
                ? GameTypes.Outcome.Draw
                : (submitted == 1 ? GameTypes.Outcome.PlayerA : GameTypes.Outcome.PlayerB);
            require(arena.getMatch(id).outcome == expected, "Wrong timeout winner");
            rejected(
                id,
                OBSERVER,
                abi.encodeCall(Arena.advanceExpiredPhase, (id, uint8(1), summary.phase)),
                IArena.InvalidPhase.selector
            );
        }
    }

    // Each of at most twenty rounds must execute and assert the actual local protocol.
    // forge-lint: disable-next-item(calls-loop, require-revert-in-loop)
    function testFuzzCompleteLegalGame(uint64 seed, bool guestFirst) public {
        uint256 id = room();
        for (uint256 index = 0; index < GameTypes.MAX_ROUNDS; ++index) {
            GameTypes.BattleState memory beforeState = arena.getBattleState(id);
            if (beforeState.outcome != GameTypes.Outcome.None) break;
            GameTypes.Action[3] memory a =
                SafetyActions.generate(beforeState, 0, uint256(seed) + index * 17);
            GameTypes.Action[3] memory b =
                SafetyActions.generate(beforeState, 1, uint256(seed) + index * 83 + 1);
            commit(id, HOST, a, SALT_A);
            rejected(
                id,
                HOST,
                abi.encodeCall(Arena.commitActions, (id, beforeState.round, SALT_B)),
                IArena.AlreadyCommitted.selector
            );
            rejected(
                id,
                HOST,
                abi.encodeCall(Arena.revealActions, (id, beforeState.round, a, SALT_A)),
                IArena.InvalidPhase.selector
            );
            commit(id, GUEST, b, SALT_B);
            {
                (address player, GameTypes.Action[3] memory orders, bytes32 salt) =
                    guestFirst ? (GUEST, b, SALT_B) : (HOST, a, SALT_A);
                reveal(id, player, orders, salt);
                rejected(
                    id,
                    player,
                    abi.encodeCall(Arena.revealActions, (id, beforeState.round, orders, salt)),
                    IArena.AlreadyRevealed.selector
                );
                rejected(
                    id,
                    OBSERVER,
                    abi.encodeCall(Arena.settleRound, (id, beforeState.round)),
                    IArena.InvalidPhase.selector
                );
                (player, orders, salt) = guestFirst ? (HOST, a, SALT_A) : (GUEST, b, SALT_B);
                reveal(id, player, orders, salt);
            }
            (GameTypes.BattleState memory expected,) = BattleResolver.resolve(beforeState, a, b);
            if (beforeState.round > 1) {
                rejected(
                    id,
                    OBSERVER,
                    abi.encodeCall(Arena.settleRound, (id, beforeState.round - 1)),
                    IArena.StaleRound.selector
                );
            }
            arena.settleRound(id, beforeState.round);
            GameTypes.BattleState memory actual = arena.getBattleState(id);
            require(
                keccak256(abi.encode(expected)) == keccak256(abi.encode(actual)),
                "Persisted round differs"
            );
            SafetyActions.checkState(actual);
            require(
                arena.getMatch(id).stateHash == GameHash.hashBattleState(context(id), actual),
                "Round hash differs"
            );
            rejected(
                id,
                OBSERVER,
                abi.encodeCall(Arena.settleRound, (id, beforeState.round)),
                IArena.InvalidPhase.selector
            );
            if (actual.outcome == GameTypes.Outcome.None) {
                rejected(
                    id,
                    HOST,
                    abi.encodeCall(Arena.commitActions, (id, beforeState.round, SALT_A)),
                    IArena.StaleRound.selector
                );
                GameTypes.RoundStatus memory status = arena.getRoundStatus(id);
                require(
                    !status.committed[0] && !status.committed[1] && !status.revealed[0]
                        && !status.revealed[1],
                    "Round not reset"
                );
            }
        }
        require(arena.getMatch(id).phase == GameTypes.Phase.Finished, "Legal game did not finish");
        rejected(
            id,
            HOST,
            abi.encodeCall(Arena.commitActions, (id, arena.getMatch(id).round, SALT_A)),
            IArena.InvalidPhase.selector
        );
        rejected(
            id,
            HOST,
            abi.encodeCall(
                Arena.revealActions, (id, arena.getMatch(id).round, SafetyActions.holds(), SALT_A)
            ),
            IArena.InvalidPhase.selector
        );
        rejected(id, GUEST, abi.encodeCall(Arena.joinMatch, (id)), IArena.InvalidPhase.selector);
        rejected(id, HOST, abi.encodeCall(Arena.startMatch, (id)), IArena.InvalidPhase.selector);
        rejected(
            id, HOST, abi.encodeCall(Arena.cancelWaitingMatch, (id)), IArena.InvalidPhase.selector
        );
        rejected(
            id,
            OBSERVER,
            abi.encodeCall(Arena.expireWaitingMatch, (id)),
            IArena.InvalidPhase.selector
        );
    }
}
