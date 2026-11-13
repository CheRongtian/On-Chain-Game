// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadTimeoutFixture } from "./SquadTimeout.t.sol";
import { IRevealVm } from "./SquadReveal.t.sol";
import { SquadCodec } from "../src/SquadCodec.sol";
import { SquadProtocol as Protocol } from "../src/SquadProtocol.sol";
import { SquadSafetySupport as Support } from "./SquadSafetySupport.sol";
import { IDevVm } from "../script/IDevVm.sol";
import { ISquadEvents } from "../src/ISquadArena.sol";

// The recorder and bounded public-call matrices are acceptance fixtures only.
// forge-lint: disable-start(multi-contract-file,literal-instead-of-constant,calls-loop,require-revert-in-loop)
interface IAdversarialVm is IRevealVm {
    function record() external;
    function accesses(address target)
        external
        returns (bytes32[] memory reads, bytes32[] memory writes);
}

contract SquadAdversarialTest is SquadTimeoutFixture {
    function _game() private returns (uint256 id) {
        id = _ready(1, [uint8(1), 2, 3], [uint8(3), 4, 5], SALT_A, SALT_B);
        _reveal(id, HOST, [uint8(1), 2, 3], SALT_A);
        _reveal(id, GUEST, [uint8(3), 4, 5], SALT_B);
    }

    function _play(uint256 id, bool points, bool guestFirst)
        private
        returns (Frame[] memory frames)
    {
        Frame[] memory buffer = new Frame[](20);
        uint256 count = 0;
        while (arena.getMatch(id).phase != Protocol.FINISHED && count < 20) {
            uint16 round = arena.getMatch(id).activeRound;
            SquadCodec.Action[3][2] memory actions =
                points ? _pointsOrders(round) : _eliminationOrders(round, arena.getBattleState(id));
            buffer[count++] = _round(id, actions, guestFirst);
        }
        require(arena.getMatch(id).phase == Protocol.FINISHED, "Game did not finish");
        require(arena.getMatch(id).outcome == 1, "Wrong game winner");
        require(arena.getMatch(id).reason == (points ? 3 : 1), "Wrong game reason");
        frames = new Frame[](count);
        for (uint256 i = 0; i < count; ++i) {
            frames[i] = buffer[i];
        }
    }

    function _pointsOrders(uint16 round)
        private
        pure
        returns (SquadCodec.Action[3][2] memory actions)
    {
        actions = Support.holds();
        uint8[5] memory route = [uint8(9), 10, 18, 26, 27];
        if (round <= route.length) actions[0][0] = _move(route[round - 1], 255);
    }

    // Each branch is one round of a fixed legal route from the real birth slots.
    // forge-lint: disable-next-item(cyclomatic-complexity)
    function _eliminationOrders(uint16 round, SquadCodec.State memory state)
        private
        pure
        returns (SquadCodec.Action[3][2] memory actions)
    {
        actions = Support.holds();
        if (round == 1) {
            actions[1][0] =
                SquadCodec.Action(3, 255, 255, 4, uint32(54 | (53 << 6) | (52 << 12) | (51 << 18)));
            actions[1][1] = _move(38, 37);
            actions[1][2] = _move(15, 7);
        } else if (round == 2) {
            actions[1][0] = SquadCodec.Action(1, 255, 255, 3, uint32(50 | (49 << 6) | (48 << 12)));
            actions[1][1] = _move(36, 35);
            actions[1][2] = _move(6, 5);
        } else if (round == 3) {
            actions[1][1] = _move(34, 33);
            actions[1][2] = _move(4, 3);
        } else if (round == 4) {
            actions[1][1] = _move(32, 255);
            actions[1][2] = _move(2, 1);
        } else if (round == 5) {
            actions[1][2] = _move(9, 255);
        }
        if (round >= 3 && state.units[3].alive) {
            actions[0][2] = SquadCodec.Action(2, 48, 255, 0, 0);
        }
        if (round >= 5 && state.units[4].alive) {
            actions[0][1] = SquadCodec.Action(2, 32, 255, 0, 0);
        }
        if (round >= 6 && state.units[5].alive) {
            actions[0][0] = SquadCodec.Action(2, 9, 255, 0, 0);
        }
    }

    function _immutable(uint256 id) private {
        uint16 round = arena.getMatch(id).activeRound;
        uint8 phase = arena.getMatch(id).phase;
        SquadCodec.Action[3][2] memory actions = Support.holds();
        bytes[10] memory calls = [
            abi.encodeCall(arena.joinMatch, (id)),
            abi.encodeCall(arena.startMatch, (id)),
            abi.encodeCall(arena.cancelWaitingMatch, (id)),
            abi.encodeCall(arena.expireWaitingMatch, (id)),
            abi.encodeCall(arena.commitSquad, (id, SALT_A)),
            abi.encodeCall(arena.revealSquad, (id, _a(), SALT_A)),
            abi.encodeCall(arena.commitActions, (id, round, SALT_A)),
            abi.encodeCall(arena.revealActions, (id, round, actions[0], SALT_A)),
            abi.encodeCall(arena.settleRound, (id, round)),
            abi.encodeCall(arena.advanceExpiredPhase, (id, round, uint8(4)))
        ];
        uint8[10] memory expected = [uint8(1), 1, 1, 1, 2, 3, 4, 5, 6, 4];
        for (uint256 i = 0; i < calls.length; ++i) {
            _rejectTurn(
                id,
                HOST,
                calls[i],
                abi.encodeWithSelector(Protocol.InvalidPhase.selector, expected[i], phase)
            );
        }
    }

    function _export(Frame[] memory frames, string memory name) private {
        // Public deterministic inputs and actual native protocol outputs feed the signed-node checks.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        VM.writeFile(
            string.concat("../.local/simulation/squad-rooms/match-", name, ".abi"),
            VM.toString(abi.encode(frames))
        );
    }

    function testCompletePointsGame() public {
        uint256 id = _game();
        Frame[] memory frames = _play(id, true, false);
        require(frames.length == 10 && frames[9].next.victoryPoints[0] == 12, "VP witness");
        _immutable(id);
        _export(frames, "points");
    }

    function testCompleteEliminationGame() public {
        uint256 id = _game();
        Frame[] memory frames = _play(id, false, true);
        SquadCodec.State memory state = arena.getBattleState(id);
        for (uint256 slot = 0; slot < 3; ++slot) {
            require(state.units[slot].alive, "Unexpected winner death");
            require(
                !state.units[slot + 3].alive && state.units[slot + 3].position == 255
                    && state.units[slot + 3].hp == 0 && state.units[slot + 3].lockedRound == 0,
                "Noncanonical eliminated slot"
            );
        }
        _immutable(id);
        _export(frames, "elimination");
    }

    function testCompleteGameRevealOrderSameContext() public {
        uint256 id = _game();
        uint256 saved = VM.snapshotState();
        Frame[] memory first = _play(id, false, false);
        bytes memory finalState = _snapshot(id);
        require(VM.revertToState(saved), "Restore exact game context");
        Frame[] memory second = _play(id, false, true);
        _equal(abi.encode(first), abi.encode(second), "fullGame.order.frames");
        _equal(_snapshot(id), finalState, "fullGame.order.terminal");
    }

    function _onlyCommitWrites(bytes32 value, bytes32 salt, bytes memory payload, bytes32 topic)
        private
    {
        IAdversarialVm recorder = IAdversarialVm(address(VM));
        recorder.record();
        VM.recordLogs();
        VM.prank(HOST);
        // Inspect precisely the storage written by the actual public Commit entry.
        // forge-lint: disable-next-line(low-level-calls)
        (bool ok,) = address(arena).call(payload);
        require(ok, "Commit failed");
        // Read slots do not expose a stored preimage; this assertion examines every write.
        // forge-lint: disable-next-line(unused-return)
        (, bytes32[] memory writes) = recorder.accesses(address(arena));
        require(writes.length == 2, "Commit wrote more than hash and flags");
        uint256 commitments = 0;
        uint256 flags = 0;
        for (uint256 i = 0; i < writes.length; ++i) {
            bytes32 stored = VM.load(address(arena), writes[i]);
            require(stored != salt, "Commit stored Salt");
            if (stored == value) ++commitments;
            else if (stored == bytes32(uint256(1))) ++flags;
        }
        require(commitments == 1 && flags == 1, "Unexpected Commit storage");
        IDevVm.Log[] memory logs = VM.getRecordedLogs();
        require(logs.length == 1 && logs[0].topics[0] == topic, "Commit public event");
        _equal(logs[0].data, abi.encode(value), "commit.event.onlyHash");
    }

    function testActualCommitStorageContainsOnlyHashAndFlags() public {
        bytes32 salt = keccak256("public native fixture Salt with nonzero high bytes");
        uint256 id = _open(1);
        bytes32 value = _value(_input(id, HOST, _a(), salt));
        _onlyCommitWrites(
            value,
            salt,
            abi.encodeCall(arena.commitSquad, (id, value)),
            ISquadEvents.SquadCommitted.selector
        );
        _commit(id, GUEST, _value(_input(id, GUEST, _b(), SALT_B)));
        _reveal(id, HOST, _a(), salt);
        require(
            !arena.getSquadStatus(id).revealed[1] && arena.getSquadStatus(id).unitTypes[1][0] == 0
                && !arena.getBattleState(id).battleStarted,
            "First Reveal exposed other lineup or initialized"
        );
        _reveal(id, GUEST, _b(), SALT_B);
        SquadCodec.Action[3][2] memory actions = Support.holds();
        value = _turnHash(id, 1, HOST, actions[0], salt);
        _onlyCommitWrites(
            value,
            salt,
            abi.encodeCall(arena.commitActions, (id, uint16(1), value)),
            ISquadEvents.ActionCommitted.selector
        );
    }

    function testEveryDefaultTerminalRejectsAllWrites() public {
        for (uint8 phase = 2; phase <= 5; ++phase) {
            for (uint8 mask = 0; mask < 3; ++mask) {
                uint256 id = _stage(phase, mask);
                _timeout(id, phase, mask, OBSERVER);
                _immutable(id);
            }
        }
    }

    function testWaitingClosuresRejectAllWrites() public {
        uint256 id = _waiting(true);
        VM.prank(HOST);
        arena.cancelWaitingMatch(id);
        _immutable(id);
        id = _waiting(false);
        VM.warp(uint256(arena.getMatch(id).joinDeadline) + 1);
        VM.prank(OBSERVER);
        arena.expireWaitingMatch(id);
        _immutable(id);
    }
}
// forge-lint: disable-end(multi-contract-file,literal-instead-of-constant,calls-loop,require-revert-in-loop)
