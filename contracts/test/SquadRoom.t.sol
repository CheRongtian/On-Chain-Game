// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadArena } from "../src/SquadArena.sol";
import { SquadProtocol as Protocol } from "../src/SquadProtocol.sol";
import { SquadCodec } from "../src/SquadCodec.sol";
import { SquadRules } from "../src/SquadRules.sol";
import { SquadParameters as Parameters } from "../src/SquadParameters.sol";
import { ISquadEvents } from "../src/ISquadArena.sol";
import { IDevVm } from "../script/IDevVm.sol";

// Literal boundary inputs, repeated public calls and assertions describe these protocol fixtures.
// forge-lint: disable-start(literal-instead-of-constant,calls-loop,require-revert-in-loop)
contract SquadRoomTest {
    IDevVm private constant VM = IDevVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address private constant HOST = address(0xA11CE);
    address private constant GUEST = address(0xB0B);
    address private constant OBSERVER = address(0xCAFE);
    SquadArena private arena;

    function setUp() public {
        arena = new SquadArena();
        VM.warp(1_700_000_000);
    }

    function testAllMapsKeepMetadataAndEmptyBoard() public {
        require(arena.getRulesetId() == SquadRules.rulesetId(), "Ruleset differs");
        (uint16 actions, uint16 states, uint16 events_) = arena.getSchemaVersions();
        uint16[3] memory schemas = Parameters.schemas();
        require(
            actions == schemas[0] && states == schemas[1] && events_ == schemas[2], "Schemas differ"
        );
        _equal(abi.encode(arena.getRules()), abi.encode(SquadRules.getRules()));
        for (uint8 mapId = 1; mapId <= Parameters.MAP_COUNT; ++mapId) {
            uint256 id = _create(mapId);
            require(id == mapId, "Match ID skipped");
            _equal(abi.encode(arena.getMap(mapId)), abi.encode(SquadRules.getMap(mapId)));
            _check(id, mapId, Protocol.WAITING);
            VM.prank(GUEST);
            arena.joinMatch(id);
            _check(id, mapId, Protocol.WAITING);
            VM.prank(HOST);
            arena.startMatch(id);
            _check(id, mapId, Protocol.SQUAD_COMMIT);
            _commit(id, HOST, bytes32(uint256(1)));
            _commit(id, GUEST, bytes32(uint256(2)));
            _check(id, mapId, Protocol.SQUAD_REVEAL);
        }
    }

    function testHostControlsStartAndSeat() public {
        uint256 id = _create(1);
        _reject(
            id,
            HOST,
            abi.encodeCall(arena.joinMatch, (id)),
            abi.encodeWithSelector(Protocol.SelfJoin.selector)
        );
        _reject(
            id,
            HOST,
            abi.encodeCall(arena.startMatch, (id)),
            abi.encodeWithSelector(Protocol.OpponentMissing.selector)
        );
        VM.prank(GUEST);
        arena.joinMatch(id);
        require(arena.getMatch(id).phase == Protocol.WAITING, "Join started Squad");
        _reject(
            id,
            OBSERVER,
            abi.encodeCall(arena.joinMatch, (id)),
            abi.encodeWithSelector(Protocol.RoomFull.selector)
        );
        _reject(
            id,
            GUEST,
            abi.encodeCall(arena.startMatch, (id)),
            abi.encodeWithSelector(Protocol.NotCreator.selector, GUEST)
        );
        _reject(
            id,
            OBSERVER,
            abi.encodeCall(arena.startMatch, (id)),
            abi.encodeWithSelector(Protocol.NotCreator.selector, OBSERVER)
        );
        VM.prank(HOST);
        arena.startMatch(id);
        _reject(
            id,
            HOST,
            abi.encodeCall(arena.startMatch, (id)),
            abi.encodeWithSelector(
                Protocol.InvalidPhase.selector, Protocol.WAITING, Protocol.SQUAD_COMMIT
            )
        );
    }

    function testCommitPermissionsAndAtomicRejection() public {
        uint256 id = _create(1);
        bytes32 value = bytes32(uint256(1));
        _reject(
            id,
            HOST,
            abi.encodeCall(arena.commitSquad, (id, value)),
            abi.encodeWithSelector(
                Protocol.InvalidPhase.selector, Protocol.SQUAD_COMMIT, Protocol.WAITING
            )
        );
        VM.prank(GUEST);
        arena.joinMatch(id);
        VM.prank(HOST);
        arena.startMatch(id);
        _reject(
            id,
            OBSERVER,
            abi.encodeCall(arena.commitSquad, (id, value)),
            abi.encodeWithSelector(Protocol.NotPlayer.selector, OBSERVER)
        );
        _commit(id, GUEST, value);
        _reject(
            id,
            GUEST,
            abi.encodeCall(arena.commitSquad, (id, bytes32(uint256(2)))),
            abi.encodeWithSelector(Protocol.AlreadyCommitted.selector, GUEST)
        );
        _commit(id, HOST, value);
        _reject(
            id,
            HOST,
            abi.encodeCall(arena.commitSquad, (id, value)),
            abi.encodeWithSelector(
                Protocol.InvalidPhase.selector, Protocol.SQUAD_COMMIT, Protocol.SQUAD_REVEAL
            )
        );
        _reject(
            id,
            OBSERVER,
            abi.encodeCall(arena.joinMatch, (id)),
            abi.encodeWithSelector(
                Protocol.InvalidPhase.selector, Protocol.WAITING, Protocol.SQUAD_REVEAL
            )
        );
    }

    function testZeroCommitmentStillLocksItsSlot() public {
        uint256 id = _started(1);
        _commit(id, HOST, bytes32(0));
        require(arena.getSquadStatus(id).committed[0], "Zero hash lost submission");
        _reject(
            id,
            HOST,
            abi.encodeCall(arena.commitSquad, (id, bytes32(0))),
            abi.encodeWithSelector(Protocol.AlreadyCommitted.selector, HOST)
        );
        _reject(
            id,
            HOST,
            abi.encodeCall(arena.commitSquad, (id, bytes32(uint256(1)))),
            abi.encodeWithSelector(Protocol.AlreadyCommitted.selector, HOST)
        );
        _commit(id, GUEST, bytes32(0));
        require(arena.getMatch(id).phase == Protocol.SQUAD_REVEAL, "Zero hashes blocked transition");
    }

    function testFuzzCommitOrderAndDeadline(bytes32 a, bytes32 b, bool guestFirst, uint16 elapsed)
        public
    {
        uint256 id = _started(1);
        uint64 deadline = arena.getMatch(id).phaseDeadline;
        VM.warp(uint256(deadline) - 600 + elapsed % 601);
        _commit(id, guestFirst ? GUEST : HOST, guestFirst ? b : a);
        require(arena.getMatch(id).phaseDeadline == deadline, "First commit changed window");
        VM.warp(deadline);
        _commit(id, guestFirst ? HOST : GUEST, guestFirst ? a : b);
        SquadCodec.MatchSummary memory summary = arena.getMatch(id);
        require(
            summary.phase == Protocol.SQUAD_REVEAL && summary.phaseDeadline == deadline + 600,
            "Second commit did not open full Reveal window"
        );
        SquadCodec.SquadStatus memory status = arena.getSquadStatus(id);
        require(
            status.commitments[0] == a && status.commitments[1] == b && status.committed[0]
                && status.committed[1],
            "Commit order changed slots"
        );
        _check(id, 1, Protocol.SQUAD_REVEAL);
    }

    function testJoinAndStartDeadlineBoundaries() public {
        for (uint256 operation = 0; operation < 2; ++operation) {
            for (uint256 offset = 0; offset < 3; ++offset) {
                uint256 id = _create(1);
                uint64 deadline = arena.getMatch(id).joinDeadline;
                if (operation == 1) {
                    VM.prank(GUEST);
                    arena.joinMatch(id);
                }
                VM.warp(uint256(deadline) - 1 + offset);
                bytes memory payload = operation == 0
                    ? abi.encodeCall(arena.joinMatch, (id))
                    : abi.encodeCall(arena.startMatch, (id));
                address caller = operation == 0 ? GUEST : HOST;
                if (offset == 2) {
                    _reject(
                        id,
                        caller,
                        payload,
                        abi.encodeWithSelector(Protocol.DeadlinePassed.selector, deadline)
                    );
                } else {
                    VM.prank(caller);
                    // Raw calls share the same boundary matrix for join and host start.
                    // forge-lint: disable-next-line(low-level-calls)
                    (bool accepted,) = address(arena).call(payload);
                    require(accepted, "Timely room operation rejected");
                    require(
                        arena.getMatch(id).phase
                            == (operation == 0 ? Protocol.WAITING : Protocol.SQUAD_COMMIT),
                        "Room boundary changed phase"
                    );
                }
            }
        }
    }

    function testExpiredCommitPreservesBothSlots() public {
        for (uint256 first = 0; first < 2; ++first) {
            uint256 id = _started(1);
            if (first == 1) _commit(id, HOST, bytes32(uint256(1)));
            uint64 deadline = arena.getMatch(id).phaseDeadline;
            VM.warp(uint256(deadline) + 1);
            _reject(
                id,
                GUEST,
                abi.encodeCall(arena.commitSquad, (id, bytes32(uint256(2)))),
                abi.encodeWithSelector(Protocol.DeadlinePassed.selector, deadline)
            );
        }
    }

    function testInvalidMapsAndUnknownRooms() public {
        uint8[3] memory maps = [uint8(0), 4, 255];
        for (uint256 index = 0; index < maps.length; ++index) {
            bytes memory expected =
                abi.encodeWithSelector(Protocol.UnknownMap.selector, maps[index]);
            _rejectedCall(HOST, abi.encodeCall(arena.createMatch, (maps[index])), expected);
            _rejectedCall(HOST, abi.encodeCall(arena.getMap, (maps[index])), expected);
        }
        require(_create(1) == 1, "Invalid map consumed ID");
        bytes memory unknown = abi.encodeWithSelector(Protocol.UnknownMatch.selector, uint256(999));
        _rejectedCall(HOST, abi.encodeCall(arena.joinMatch, (999)), unknown);
        _rejectedCall(HOST, abi.encodeCall(arena.startMatch, (999)), unknown);
        _rejectedCall(HOST, abi.encodeCall(arena.commitSquad, (999, bytes32(0))), unknown);
        _rejectedCall(HOST, abi.encodeCall(arena.getMatch, (999)), unknown);
        _rejectedCall(HOST, abi.encodeCall(arena.getBattleState, (999)), unknown);
        _rejectedCall(HOST, abi.encodeCall(arena.getSquadStatus, (999)), unknown);
        _rejectedCall(HOST, abi.encodeCall(arena.getRoundStatus, (999)), unknown);
    }

    function testCommitmentDomainsAndContext() public {
        uint256 id = _started(1);
        SquadCodec.SquadInput memory input = SquadCodec.SquadInput(
            SquadCodec.Context(block.chainid, address(arena), id),
            HOST,
            arena.getRulesetId(),
            [uint8(1), 4, 5],
            bytes32(uint256(1))
        );
        bytes32 original = keccak256(SquadCodec.squadEncoding(input));
        for (uint256 field = 0; field < 7; ++field) {
            SquadCodec.SquadInput memory changed =
                abi.decode(abi.encode(input), (SquadCodec.SquadInput));
            if (field == 0) ++changed.context.chainId;
            else if (field == 1) changed.context.arena = address(new SquadArena());
            else if (field == 2) ++changed.context.matchId;
            else if (field == 3) changed.player = GUEST;
            else if (field == 4) changed.rulesetId ^= bytes32(uint256(1));
            else if (field == 5) changed.unitTypes = [uint8(4), 1, 5];
            else changed.salt ^= bytes32(uint256(1));
            require(
                keccak256(SquadCodec.squadEncoding(changed)) != original,
                "Commitment context collided"
            );
        }
        require(
            keccak256(
                abi.encode(
                    SquadCodec.domain(2),
                    input.context,
                    input.player,
                    input.rulesetId,
                    input.unitTypes,
                    input.salt
                )
            ) != original,
            "Squad and Action domains collided"
        );
        uint256 other = _started(2);
        _commit(id, HOST, original);
        _commit(other, HOST, bytes32(uint256(2)));
        require(
            arena.getSquadStatus(id).commitments[0] == original
                && arena.getSquadStatus(other).commitments[0] == bytes32(uint256(2)),
            "Rooms shared commitment storage"
        );
        // Commit stores opaque hashes; copying one does not prove ownership of its preimage.
        _commit(id, GUEST, original);
        _check(id, 1, Protocol.SQUAD_REVEAL);
    }

    function testEventsMatchFrozenLayoutAndPrivacy() public {
        VM.recordLogs();
        uint256 id = _create(1);
        IDevVm.Log[] memory logs = VM.getRecordedLogs();
        SquadCodec.MatchSummary memory summary = arena.getMatch(id);
        require(logs.length == 2, "Create event count");
        _event(
            logs[0],
            ISquadEvents.MatchCreated.selector,
            id,
            _addressTopic(HOST),
            abi.encode(summary.rulesetId, uint8(1), summary.mapHash, summary.joinDeadline)
        );
        _event(
            logs[1],
            ISquadEvents.PhaseAdvanced.selector,
            id,
            bytes32(0),
            abi.encode(uint8(0), Protocol.WAITING, summary.joinDeadline)
        );
        VM.recordLogs();
        VM.prank(GUEST);
        arena.joinMatch(id);
        logs = VM.getRecordedLogs();
        require(logs.length == 1, "Join event count");
        _event(
            logs[0],
            ISquadEvents.PlayerJoined.selector,
            id,
            _addressTopic(GUEST),
            abi.encode(Protocol.WAITING, summary.joinDeadline)
        );
        VM.recordLogs();
        VM.prank(HOST);
        arena.startMatch(id);
        logs = VM.getRecordedLogs();
        require(logs.length == 1, "Start event count");
        uint64 deadline = arena.getMatch(id).phaseDeadline;
        _event(
            logs[0],
            ISquadEvents.PhaseAdvanced.selector,
            id,
            bytes32(0),
            abi.encode(Protocol.WAITING, Protocol.SQUAD_COMMIT, deadline)
        );
        VM.recordLogs();
        _commit(id, HOST, bytes32(uint256(1)));
        logs = VM.getRecordedLogs();
        require(logs.length == 1, "First commit event count");
        _event(
            logs[0],
            ISquadEvents.SquadCommitted.selector,
            id,
            _addressTopic(HOST),
            abi.encode(bytes32(uint256(1)))
        );
        VM.recordLogs();
        _commit(id, GUEST, bytes32(uint256(2)));
        logs = VM.getRecordedLogs();
        require(logs.length == 2, "Second commit event count");
        _event(
            logs[0],
            ISquadEvents.SquadCommitted.selector,
            id,
            _addressTopic(GUEST),
            abi.encode(bytes32(uint256(2)))
        );
        _event(
            logs[1],
            ISquadEvents.PhaseAdvanced.selector,
            id,
            bytes32(0),
            abi.encode(
                Protocol.SQUAD_COMMIT, Protocol.SQUAD_REVEAL, arena.getMatch(id).phaseDeadline
            )
        );
        _check(id, 1, Protocol.SQUAD_REVEAL);
    }

    function _create(uint8 mapId) private returns (uint256) {
        VM.prank(HOST);
        return arena.createMatch(mapId);
    }

    function _started(uint8 mapId) private returns (uint256 id) {
        id = _create(mapId);
        VM.prank(GUEST);
        arena.joinMatch(id);
        VM.prank(HOST);
        arena.startMatch(id);
    }

    function _commit(uint256 id, address player, bytes32 value) private {
        VM.prank(player);
        arena.commitSquad(id, value);
    }

    function _snapshot(uint256 id) private view returns (bytes memory) {
        return abi.encode(
            arena.getMatch(id),
            arena.getBattleState(id),
            arena.getSquadStatus(id),
            arena.getRoundStatus(id)
        );
    }

    function _reject(uint256 id, address caller, bytes memory payload, bytes memory expected)
        private
    {
        bytes memory before_ = _snapshot(id);
        _rejectedCall(caller, payload, expected);
        _equal(before_, _snapshot(id));
    }

    function _rejectedCall(address caller, bytes memory payload, bytes memory expected) private {
        VM.recordLogs();
        VM.prank(caller);
        // Negative cases need the exact revert payload without aborting the surrounding test.
        // forge-lint: disable-next-line(low-level-calls)
        (bool accepted, bytes memory reason) = address(arena).call(payload);
        require(!accepted, "Invalid call accepted");
        _equal(reason, expected);
        require(VM.getRecordedLogs().length == 0, "Rejected call emitted success log");
    }

    function _check(uint256 id, uint8 mapId, uint8 phase) private view {
        SquadCodec.MatchSummary memory summary = arena.getMatch(id);
        require(
            summary.players[0] == HOST && summary.mapId == mapId && summary.phase == phase
                && summary.activeRound == 0 && summary.stateHash == bytes32(0)
                && summary.outcome == 0 && summary.reason == 0,
            "Room identity or pregame summary changed"
        );
        require(
            summary.rulesetId == arena.getRulesetId()
                && summary.mapHash == SquadRules.getMap(mapId).mapHash,
            "Map or rules changed"
        );
        SquadCodec.State memory battle = arena.getBattleState(id);
        SquadCodec.validateState(battle);
        require(
            battle.mapId == mapId && !battle.battleStarted && battle.completedRound == 0,
            "Battle initialized early"
        );
        SquadCodec.SquadStatus memory status = arena.getSquadStatus(id);
        SquadCodec.RoundStatus memory turn = arena.getRoundStatus(id);
        for (uint256 side = 0; side < 2; ++side) {
            require(
                !status.revealed[side] && !turn.committed[side] && !turn.revealed[side]
                    && turn.commitments[side] == bytes32(0),
                "Reveal or turn data exposed early"
            );
            for (uint256 slot = 0; slot < 3; ++slot) {
                require(status.unitTypes[side][slot] == 0, "Hidden lineup exposed");
            }
        }
    }

    function _event(
        IDevVm.Log memory entry,
        bytes32 topic,
        uint256 id,
        bytes32 indexedValue,
        bytes memory data
    ) private view {
        require(
            entry.emitter == address(arena) && entry.topics.length == 3 && entry.topics[0] == topic
                && entry.topics[1] == bytes32(id) && entry.topics[2] == indexedValue,
            "Event topics differ"
        );
        _equal(entry.data, data);
    }

    function _addressTopic(address value) private pure returns (bytes32) {
        return bytes32(uint256(uint160(value)));
    }

    function _equal(bytes memory a, bytes memory b) private pure {
        // Digests replace byte-by-byte comparison of complete multi-kilobyte protocol snapshots.
        require(a.length == b.length && keccak256(a) == keccak256(b), "Protocol bytes differ");
    }
}
// forge-lint: disable-end(literal-instead-of-constant,calls-loop,require-revert-in-loop)
