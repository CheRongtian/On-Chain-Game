// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadArena } from "../src/SquadArena.sol";
import { SquadProtocol as Protocol } from "../src/SquadProtocol.sol";
import { SquadCodec } from "../src/SquadCodec.sol";
import { SquadRules } from "../src/SquadRules.sol";
import { SquadParameters as Parameters } from "../src/SquadParameters.sol";
import { ISquadEvents } from "../src/ISquadArena.sol";
import { ISafetyVm } from "./SafetySupport.sol";
import { IDevVm } from "../script/IDevVm.sol";
import { SquadSafetySupport } from "./SquadSafetySupport.sol";

// The VM interface, shared fixture and two suites exercise the same bounded pregame protocol.
// forge-lint: disable-start(multi-contract-file,literal-instead-of-constant,calls-loop,require-revert-in-loop)
interface IRevealVm is ISafetyVm {
    function snapshotState() external returns (uint256);
    function revertToState(uint256 snapshotId) external returns (bool);
}

abstract contract SquadRevealFixture {
    error RevealDifference(string field, bytes actual, bytes expected);

    IRevealVm internal constant VM = IRevealVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address internal constant HOST = address(0xA11CE);
    address internal constant GUEST = address(0xB0B);
    address internal constant OBSERVER = address(0xCAFE);
    bytes32 internal constant SALT_A = bytes32(uint256(1));
    bytes32 internal constant SALT_B = bytes32(uint256(2));
    SquadArena internal arena;

    function setUp() public {
        arena = new SquadArena();
        VM.warp(1_700_000_000);
    }

    function _a() internal pure returns (uint8[3] memory) {
        return [uint8(1), 4, 5];
    }

    function _b() internal pure returns (uint8[3] memory) {
        return [uint8(3), 2, 4];
    }

    function _context(uint256 id) internal view returns (SquadCodec.Context memory) {
        return SquadCodec.Context(block.chainid, address(arena), id);
    }

    function _input(uint256 id, address player, uint8[3] memory types_, bytes32 salt)
        internal
        view
        returns (SquadCodec.SquadInput memory)
    {
        return SquadCodec.SquadInput(_context(id), player, arena.getRulesetId(), types_, salt);
    }

    function _value(SquadCodec.SquadInput memory input) internal pure returns (bytes32) {
        // Malformed-lineup fixtures must be committed before testing Reveal's validation.
        return keccak256(
            abi.encode(
                SquadCodec.domain(1),
                input.context,
                input.player,
                input.rulesetId,
                input.unitTypes,
                input.salt
            )
        );
    }

    function _open(uint8 mapId) internal returns (uint256 id) {
        VM.prank(HOST);
        id = arena.createMatch(mapId);
        VM.prank(GUEST);
        arena.joinMatch(id);
        VM.prank(HOST);
        arena.startMatch(id);
    }

    function _commit(uint256 id, address player, bytes32 commitment) internal {
        VM.prank(player);
        arena.commitSquad(id, commitment);
    }

    function _ready(uint8 mapId, uint8[3] memory a, uint8[3] memory b, bytes32 saltA, bytes32 saltB)
        internal
        returns (uint256 id)
    {
        id = _open(mapId);
        _commit(id, HOST, _value(_input(id, HOST, a, saltA)));
        _commit(id, GUEST, _value(_input(id, GUEST, b, saltB)));
    }

    function _reveal(uint256 id, address player, uint8[3] memory types_, bytes32 salt) internal {
        VM.prank(player);
        arena.revealSquad(id, types_, salt);
    }

    function _snapshot(uint256 id) internal view returns (bytes memory) {
        return abi.encode(
            arena.getMatch(id),
            arena.getBattleState(id),
            arena.getSquadStatus(id),
            arena.getRoundStatus(id)
        );
    }

    function _equal(bytes memory actual, bytes memory expected, string memory field) internal pure {
        // Digests replace byte-by-byte comparison of complete protocol tuples and event data.
        if (actual.length != expected.length || keccak256(actual) != keccak256(expected)) {
            revert RevealDifference(field, actual, expected);
        }
    }

    function _reject(
        uint256 id,
        address player,
        uint8[3] memory types_,
        bytes32 salt,
        bytes memory reason
    ) internal {
        bytes memory before_ = _snapshot(id);
        _rejectCall(player, abi.encodeCall(arena.revealSquad, (id, types_, salt)), reason);
        _equal(_snapshot(id), before_, "rejected.state");
    }

    function _rejectCall(address player, bytes memory payload, bytes memory reason) internal {
        VM.recordLogs();
        VM.prank(player);
        // The exact error and complete rollback are part of the negative fixture.
        // forge-lint: disable-next-line(low-level-calls)
        (bool accepted, bytes memory actual) = address(arena).call(payload);
        require(!accepted, "Invalid Reveal accepted");
        _equal(actual, reason, "rejected.error");
        require(VM.getRecordedLogs().length == 0, "Rejected Reveal emitted success event");
    }

    function _checkInitial(uint256 id, SquadCodec.State memory expected) internal view {
        _equal(abi.encode(arena.getBattleState(id)), abi.encode(expected), "initial.battle");
        SquadCodec.MatchSummary memory summary = arena.getMatch(id);
        require(
            summary.phase == Protocol.ROUND_COMMIT && summary.activeRound == 1,
            "Initial protocol round differs"
        );
        require(
            summary.phaseDeadline == VM.getBlockTimestamp() + Parameters.windows()[3],
            "Initial deadline differs"
        );
        bytes32 hash = SquadRules.hashState(_context(id), expected);
        _equal(abi.encode(summary.stateHash), abi.encode(hash), "initial.stateHash");
        require(
            summary.mapId == expected.mapId && summary.rulesetId == arena.getRulesetId()
                && summary.mapHash == arena.getMap(expected.mapId).mapHash,
            "Initial map/rules differ"
        );
        require(
            summary.players[0] == HOST && summary.players[1] == GUEST && summary.outcome == 0
                && summary.reason == 0,
            "Initial identity/result differs"
        );
        SquadCodec.RoundStatus memory empty;
        _equal(abi.encode(arena.getRoundStatus(id)), abi.encode(empty), "initial.turn");
        require(
            arena.getSquadStatus(id).revealed[0] && arena.getSquadStatus(id).revealed[1],
            "Initial Reveal flags differ"
        );
    }
}

contract SquadRevealTest is SquadRevealFixture {
    struct Reference {
        string name;
        uint8 side;
        SquadCodec.State expected;
        bytes32 stateHash;
    }

    function testAllFrozenInitializationReferences() public {
        // The existing backend entry prepares this corpus from unchanged committed expectations.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        (SquadCodec.Context memory context, Reference[] memory rows) = abi.decode(
            VM.readFileBinary("../.local/simulation/squad-rooms/initializations.abi"),
            (SquadCodec.Context, Reference[])
        );
        require(rows.length == 360, "Missing initialization references");
        for (uint256 index = 0; index < rows.length; ++index) {
            // Each external frame releases temporary memory before the next full protocol case.
            this.checkReference(context, rows[index]);
        }
    }

    function checkReference(SquadCodec.Context memory context, Reference memory row) external {
        uint8[3] memory a;
        uint8[3] memory b;
        for (uint256 slot = 0; slot < Parameters.SQUAD_SIZE; ++slot) {
            a[slot] = row.expected.units[slot].unitType;
            b[slot] = row.expected.units[slot + Parameters.SQUAD_SIZE].unitType;
        }
        uint256 id = _ready(row.expected.mapId, a, b, SALT_A, SALT_B);
        _reveal(
            id, row.side == 0 ? HOST : GUEST, row.side == 0 ? a : b, row.side == 0 ? SALT_A : SALT_B
        );
        _reveal(
            id, row.side == 0 ? GUEST : HOST, row.side == 0 ? b : a, row.side == 0 ? SALT_B : SALT_A
        );
        _checkInitial(id, row.expected);
        _equal(
            abi.encode(SquadRules.hashState(context, arena.getBattleState(id))),
            abi.encode(row.stateHash),
            row.name
        );
    }

    function testFirstRevealPublishesOnlyItsOwnLineup() public {
        uint256 id = _ready(1, _a(), _b(), SALT_A, SALT_B);
        bytes memory battle = abi.encode(arena.getBattleState(id));
        SquadCodec.MatchSummary memory before_ = arena.getMatch(id);
        _reveal(id, HOST, _a(), SALT_A);
        _equal(abi.encode(arena.getMatch(id)), abi.encode(before_), "first.summary");
        _equal(abi.encode(arena.getBattleState(id)), battle, "first.emptyBattle");
        SquadCodec.SquadStatus memory status = arena.getSquadStatus(id);
        uint8[3] memory empty;
        _equal(abi.encode(status.unitTypes[0]), abi.encode(_a()), "first.publicLineup");
        _equal(abi.encode(status.unitTypes[1]), abi.encode(empty), "first.hiddenLineup");
        require(status.revealed[0] && !status.revealed[1], "First Reveal flags differ");
    }

    function testWrongSaltOrLineupCanRetryOriginal() public {
        uint256 id = _ready(1, _a(), _b(), SALT_A, SALT_B);
        bytes memory mismatch = abi.encodeWithSelector(Protocol.CommitmentMismatch.selector);
        _reject(id, HOST, _a(), SALT_B, mismatch);
        _reject(id, HOST, [uint8(4), 1, 5], SALT_A, mismatch);
        _reject(id, HOST, [uint8(1), 3, 5], SALT_A, mismatch);
        _reveal(id, HOST, _a(), SALT_A);
        _reveal(id, GUEST, _b(), SALT_B);
        _checkInitial(id, SquadRules.initialize(1, _a(), _b()));
    }

    function testInvalidCommittedLineupsCannotBeReplaced() public {
        uint8[3][6] memory invalid = [
            [uint8(0), 2, 3],
            [uint8(6), 2, 3],
            [uint8(255), 2, 3],
            [uint8(1), 1, 2],
            [uint8(1), 2, 1],
            [uint8(5), 5, 5]
        ];
        for (uint256 index = 0; index < invalid.length; ++index) {
            uint256 id = _ready(1, invalid[index], _b(), SALT_A, SALT_B);
            _reveal(id, GUEST, _b(), SALT_B);
            _reject(
                id,
                HOST,
                invalid[index],
                SALT_A,
                abi.encodeWithSelector(SquadCodec.InvalidProtocol.selector)
            );
            _reject(
                id, HOST, _a(), SALT_A, abi.encodeWithSelector(Protocol.CommitmentMismatch.selector)
            );
            require(!arena.getBattleState(id).battleStarted, "Bad second Reveal initialized battle");
        }
    }

    function testForeignCommitmentContextsAndCopiedHashReject() public {
        for (uint256 field = 0; field < 5; ++field) {
            uint256 id = _open(1);
            SquadCodec.SquadInput memory foreign = _input(id, HOST, _a(), SALT_A);
            if (field == 0) ++foreign.context.chainId;
            else if (field == 1) foreign.context.arena = address(new SquadArena());
            else if (field == 2) ++foreign.context.matchId;
            else if (field == 3) foreign.player = GUEST;
            else foreign.rulesetId ^= bytes32(uint256(1));
            _commit(id, HOST, _value(foreign));
            _commit(id, GUEST, _value(_input(id, GUEST, _b(), SALT_B)));
            _reveal(id, GUEST, _b(), SALT_B);
            _reject(
                id, HOST, _a(), SALT_A, abi.encodeWithSelector(Protocol.CommitmentMismatch.selector)
            );
        }
        uint256 copied = _open(1);
        bytes32 value = _value(_input(copied, HOST, _a(), SALT_A));
        _commit(copied, HOST, value);
        _commit(copied, GUEST, value);
        _reveal(copied, HOST, _a(), SALT_A);
        _reject(
            copied,
            GUEST,
            _a(),
            SALT_A,
            abi.encodeWithSelector(Protocol.CommitmentMismatch.selector)
        );
    }

    function testRevealPermissionsAndWrongPhase() public {
        VM.prank(HOST);
        uint256 id = arena.createMatch(1);
        _reject(
            id,
            HOST,
            _a(),
            SALT_A,
            abi.encodeWithSelector(
                Protocol.InvalidPhase.selector, Protocol.SQUAD_REVEAL, Protocol.WAITING
            )
        );
        VM.prank(GUEST);
        arena.joinMatch(id);
        VM.prank(HOST);
        arena.startMatch(id);
        _commit(id, HOST, _value(_input(id, HOST, _a(), SALT_A)));
        _reject(
            id,
            HOST,
            _a(),
            SALT_A,
            abi.encodeWithSelector(
                Protocol.InvalidPhase.selector, Protocol.SQUAD_REVEAL, Protocol.SQUAD_COMMIT
            )
        );
        _commit(id, GUEST, _value(_input(id, GUEST, _b(), SALT_B)));
        _reject(
            id,
            OBSERVER,
            _a(),
            SALT_A,
            abi.encodeWithSelector(Protocol.NotPlayer.selector, OBSERVER)
        );
        _rejectCall(
            HOST,
            abi.encodeCall(arena.revealSquad, (999, _a(), SALT_A)),
            abi.encodeWithSelector(Protocol.UnknownMatch.selector, uint256(999))
        );
    }

    function testRepeatedRevealCannotReinitialize() public {
        uint256 id = _ready(1, _a(), _b(), SALT_A, SALT_B);
        _reveal(id, HOST, _a(), SALT_A);
        _reject(
            id, HOST, _a(), SALT_A, abi.encodeWithSelector(Protocol.AlreadyRevealed.selector, HOST)
        );
        _reveal(id, GUEST, _b(), SALT_B);
        _reject(
            id,
            HOST,
            _a(),
            SALT_A,
            abi.encodeWithSelector(
                Protocol.InvalidPhase.selector, Protocol.SQUAD_REVEAL, Protocol.ROUND_COMMIT
            )
        );
        _checkInitial(id, SquadRules.initialize(1, _a(), _b()));
    }

    function testRevealDeadlineBeforeAtAndAfter() public {
        for (uint256 first = 0; first < 2; ++first) {
            for (uint256 offset = 0; offset < 3; ++offset) {
                uint256 id = _ready(1, _a(), _b(), SALT_A, SALT_B);
                uint64 deadline = arena.getMatch(id).phaseDeadline;
                if (first == 1) _reveal(id, HOST, _a(), SALT_A);
                VM.warp(uint256(deadline) - 1 + offset);
                address player = first == 0 ? HOST : GUEST;
                uint8[3] memory types_ = first == 0 ? _a() : _b();
                bytes32 salt = first == 0 ? SALT_A : SALT_B;
                if (offset == 2) {
                    _reject(
                        id,
                        player,
                        types_,
                        salt,
                        abi.encodeWithSelector(Protocol.DeadlinePassed.selector, deadline)
                    );
                } else {
                    _reveal(id, player, types_, salt);
                    if (first == 0) {
                        require(
                            arena.getMatch(id).phaseDeadline == deadline,
                            "First Reveal extended window"
                        );
                        _reveal(id, GUEST, _b(), SALT_B);
                    }
                    _checkInitial(id, SquadRules.initialize(1, _a(), _b()));
                }
            }
        }
    }

    function testRevealOrderHasIdenticalContextStateAndHash() public {
        uint256 id = _ready(2, _a(), _b(), SALT_A, SALT_B);
        uint256 snapshot = VM.snapshotState();
        _reveal(id, HOST, _a(), SALT_A);
        _reveal(id, GUEST, _b(), SALT_B);
        bytes memory first = _snapshot(id);
        require(VM.revertToState(snapshot), "Reveal-order snapshot restore failed");
        _reveal(id, GUEST, _b(), SALT_B);
        _reveal(id, HOST, _a(), SALT_A);
        _equal(_snapshot(id), first, "revealOrder.sameContext");
    }

    function testFuzzOrderedLineups(uint256 seed, bool guestFirst) public {
        uint8[3] memory a = SquadSafetySupport.lineup(seed % 60);
        uint8[3] memory b = SquadSafetySupport.lineup((seed / 60) % 60);
        // The modulo selects exactly one frozen map.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint8 mapId = uint8(1 + seed % 3);
        uint256 id = _ready(mapId, a, b, bytes32(seed), bytes32(0));
        _reveal(
            id,
            guestFirst ? GUEST : HOST,
            guestFirst ? b : a,
            guestFirst ? bytes32(0) : bytes32(seed)
        );
        _reveal(
            id,
            guestFirst ? HOST : GUEST,
            guestFirst ? a : b,
            guestFirst ? bytes32(seed) : bytes32(0)
        );
        _checkInitial(id, SquadRules.initialize(mapId, a, b));
    }

    function testRevealAndGameStartedEventPayloads() public {
        uint256 id = _ready(3, _a(), _b(), SALT_A, SALT_B);
        VM.recordLogs();
        _reveal(id, HOST, _a(), SALT_A);
        IDevVm.Log[] memory first = VM.getRecordedLogs();
        require(first.length == 1, "First Reveal event count");
        _event(
            first[0],
            ISquadEvents.SquadRevealed.selector,
            id,
            bytes32(uint256(uint160(HOST))),
            abi.encode(_a(), SALT_A)
        );
        VM.recordLogs();
        _reveal(id, GUEST, _b(), SALT_B);
        IDevVm.Log[] memory second = VM.getRecordedLogs();
        require(second.length == 3, "Second Reveal event count");
        _event(
            second[0],
            ISquadEvents.SquadRevealed.selector,
            id,
            bytes32(uint256(uint160(GUEST))),
            abi.encode(_b(), SALT_B)
        );
        _event(
            second[1],
            ISquadEvents.GameStarted.selector,
            id,
            bytes32(0),
            abi.encode(SquadRules.initialize(3, _a(), _b()), arena.getMatch(id).stateHash)
        );
        _event(
            second[2],
            ISquadEvents.PhaseAdvanced.selector,
            id,
            bytes32(uint256(1)),
            abi.encode(
                Protocol.SQUAD_REVEAL, Protocol.ROUND_COMMIT, arena.getMatch(id).phaseDeadline
            )
        );
    }

    function _event(
        IDevVm.Log memory entry,
        bytes32 topic,
        uint256 id,
        bytes32 indexedValue,
        bytes memory data
    ) private view {
        require(
            entry.emitter == address(arena) && entry.topics[0] == topic
                && entry.topics[1] == bytes32(id),
            "Reveal event identity differs"
        );
        if (topic == ISquadEvents.GameStarted.selector) {
            require(entry.topics.length == 2, "GameStarted topic count");
        } else {
            require(
                entry.topics.length == 3 && entry.topics[2] == indexedValue,
                "Reveal event index differs"
            );
        }
        _equal(entry.data, data, "event.data");
    }
}

contract SquadRevealGasTest is SquadRevealFixture {
    function testGasFirstReveal() public {
        VM.pauseGasMetering();
        uint256 id = _ready(1, _a(), _b(), SALT_A, SALT_B);
        _measure(id, HOST, _a(), SALT_A, "first");
        require(!arena.getBattleState(id).battleStarted, "First Reveal initialized early");
    }

    function testGasSecondRevealAndInitialization() public {
        VM.pauseGasMetering();
        uint256 id = _ready(1, _a(), _b(), SALT_A, SALT_B);
        _reveal(id, HOST, _a(), SALT_A);
        _measure(id, GUEST, _b(), SALT_B, "second");
        _checkInitial(id, SquadRules.initialize(1, _a(), _b()));
    }

    function _measure(
        uint256 id,
        address player,
        uint8[3] memory types_,
        bytes32 salt,
        string memory position
    ) private {
        bytes memory payload = abi.encodeCall(arena.revealSquad, (id, types_, salt));
        VM.resumeGasMetering();
        VM.prank(player);
        uint256 before_ = gasleft();
        // Raw calldata permits a measured external call with the same public method signature.
        // forge-lint: disable-next-line(low-level-calls)
        (bool accepted, bytes memory reason) = address(arena).call(payload);
        uint256 isolatedTransactionGas = before_ - gasleft();
        VM.pauseGasMetering();
        require(accepted, string(reason));
        // Isolated external calls already include this intrinsic component in the gasleft delta.
        uint256 intrinsic = 21_000;
        for (uint256 index = 0; index < payload.length; ++index) {
            intrinsic += payload[index] == 0 ? 4 : 16;
        }
        string memory row = string.concat(
            '{"position":"',
            position,
            '","isolatedTransactionGas":',
            VM.toString(isolatedTransactionGas),
            ',"intrinsicIncluded":',
            VM.toString(intrinsic),
            ',"target":250000}'
        );
        // Keep the two isolated samples beside existing safety evidence; the driver collects all misses.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        VM.writeFile(string.concat("../.local/safety/squad-reveal-gas-", position, ".json"), row);
    }
}
// forge-lint: disable-end(multi-contract-file,literal-instead-of-constant,calls-loop,require-revert-in-loop)
