// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "../src/SquadCodec.sol";
import { SquadRules } from "../src/SquadRules.sol";
import { ISquadEvents } from "../src/ISquadArena.sol";
import { IDevVm } from "./IDevVm.sol";

// Fixture IDs are fixed by the shared corpus; every case records and writes its emitted log.
// forge-lint: disable-start(multi-contract-file,calls-loop,require-revert-in-loop,literal-instead-of-constant)

interface IProtocolVm is IDevVm {
    function writeLine(string calldata path, string calldata data) external;
}

contract SquadProtocolProbe is ISquadEvents {
    mapping(uint256 => SquadCodec.MatchData) private matches;

    struct InitialInput {
        SquadCodec.Context context;
        uint8 mapId;
        uint8[3] typesA;
        uint8[3] typesB;
    }

    struct EventInput {
        uint8 eventType;
        uint256 matchId;
        uint16 round;
        address player;
        bytes32 rulesetId;
        uint8 mapId;
        bytes32 mapHash;
        uint64 deadline;
        bytes32 commitment;
        uint8[3] unitTypes;
        bytes32 salt;
        SquadCodec.State state;
        SquadCodec.Action[3] actions;
        uint8 fromPhase;
        uint8 toPhase;
        bytes32 beforeHash;
        bytes32 afterHash;
        SquadCodec.Effects effects;
        address winner;
    }

    function evaluate(uint8 kind, bytes calldata payload) external returns (bytes memory) {
        if (kind == 0) return abi.encode(SquadCodec.domain(abi.decode(payload, (uint8))));
        if (kind == 1) return SquadCodec.rulesEncoding(abi.decode(payload, (SquadCodec.Rules)));
        if (kind == 2) {
            return SquadCodec.squadEncoding(abi.decode(payload, (SquadCodec.SquadInput)));
        }
        if (kind == 3) {
            return SquadCodec.actionEncoding(abi.decode(payload, (SquadCodec.ActionInput)));
        }
        if (kind == 4) {
            return SquadCodec.stateEncoding(abi.decode(payload, (SquadCodec.StateInput)));
        }
        if (kind > 5) return _evaluateTypes(kind, payload);
        _emitEvent(abi.decode(payload, (EventInput)));
        return "";
    }

    function _evaluateTypes(uint8 kind, bytes calldata payload) private returns (bytes memory) {
        if (kind == 6) {
            InitialInput memory input = abi.decode(payload, (InitialInput));
            SquadCodec.State memory state =
                SquadRules.initialize(input.mapId, input.typesA, input.typesB);
            return abi.encode(state, SquadRules.hashState(input.context, state));
        }
        if (kind == 7) {
            return abi.encode(SquadRules.normalizeUnit(abi.decode(payload, (SquadCodec.Unit))));
        }
        if (kind == 8) return SquadCodec.rulesEncoding(SquadRules.getRules());
        if (kind == 9) return abi.encode(SquadRules.getMap(abi.decode(payload, (uint8))));
        if (kind == 10) {
            (address peer, bytes32 originalRules) = abi.decode(payload, (address, bytes32));
            _checkIsolation(SquadProtocolProbe(peer), originalRules);
            return abi.encode(true);
        }
        revert SquadCodec.InvalidProtocol();
    }

    // Only this disposable fixture probe exposes storage writes; no runtime Arena is deployed here.
    function seedMatch(uint256 id, uint8 mapId, uint8[3] memory typesA, uint8[3] memory typesB)
        external
    {
        SquadCodec.MatchData storage room = matches[id];
        SquadCodec.State memory state = SquadRules.initialize(mapId, typesA, typesB);
        room.battle.mapId = state.mapId;
        room.battle.battleStarted = state.battleStarted;
        room.battle.completedRound = state.completedRound;
        room.battle.energy = state.energy;
        room.battle.victoryPoints = state.victoryPoints;
        room.battle.outcome = state.outcome;
        room.battle.reason = state.reason;
        for (uint256 id_ = 0; id_ < 6; ++id_) {
            room.battle.units[id_] = state.units[id_];
        }
        room.summary.mapId = mapId;
        room.summary.rulesetId = SquadRules.rulesetId();
        room.summary.activeRound = 1;
        room.squad.unitTypes = [typesA, typesB];
    }

    function storedMatch(uint256 id) external view returns (SquadCodec.MatchData memory) {
        return matches[id];
    }

    function _checkIsolation(SquadProtocolProbe peer, bytes32 originalRules) private {
        uint8[3] memory typesA = [uint8(1), 4, 5];
        uint8[3] memory typesB = [uint8(3), 2, 1];
        this.seedMatch(1, 1, typesA, typesB);
        this.seedMatch(2, 2, typesB, typesA);
        peer.seedMatch(1, 3, typesA, typesB);
        matches[1].battle.units[0].hp = 1;
        matches[1].squad.committed[0] = true;
        matches[1].turn.committed[0] = true;
        matches[1].revealedActions[0] = 42;
        SquadCodec.MatchData memory other = this.storedMatch(2);
        SquadCodec.MatchData memory separate = peer.storedMatch(1);
        require(matches[1].battle.units[0].hp == 1, "Fixture mutation did not execute");
        require(
            other.battle.units[0].hp == 5 && separate.battle.units[0].hp == 10,
            "Unit storage leaked"
        );
        require(other.summary.mapId == 2 && separate.summary.mapId == 3, "Room metadata leaked");
        require(
            other.squad.unitTypes[0][0] == 3 && separate.squad.unitTypes[0][0] == 1,
            "Squad slots leaked"
        );
        require(!other.squad.committed[0] && !separate.squad.committed[0], "Squad flags leaked");
        require(!other.turn.committed[0] && !separate.turn.committed[0], "Round flags leaked");
        require(
            other.revealedActions[0] == 0 && separate.revealedActions[0] == 0,
            "Action storage leaked"
        );
        SquadCodec.State memory state = SquadRules.initialize(1, typesA, typesB);
        SquadCodec.Context memory context = SquadCodec.Context(block.chainid, address(this), 1);
        bytes32 stateHash = SquadRules.hashState(context, state);
        context.matchId = 2;
        require(SquadRules.hashState(context, state) != stateHash, "Match hash context leaked");
        context.matchId = 1;
        context.arena = address(peer);
        require(SquadRules.hashState(context, state) != stateHash, "Arena hash context leaked");
        context.arena = address(this);
        context.chainId += 1;
        require(SquadRules.hashState(context, state) != stateHash, "Chain hash context leaked");
        require(SquadRules.rulesetId() != originalRules, "Original rules identity was reused");
    }

    function _emitEvent(EventInput memory value) private {
        if (value.eventType == 0) {
            emit MatchCreated(
                value.matchId,
                value.player,
                value.rulesetId,
                value.mapId,
                value.mapHash,
                value.deadline
            );
        } else if (value.eventType == 1) {
            emit PlayerJoined(value.matchId, value.player, value.toPhase, value.deadline);
        } else if (value.eventType == 2) {
            emit SquadCommitted(value.matchId, value.player, value.commitment);
        } else if (value.eventType == 3) {
            emit SquadRevealed(value.matchId, value.player, value.unitTypes, value.salt);
        } else if (value.eventType == 4) {
            emit GameStarted(value.matchId, value.state, value.afterHash);
        } else if (value.eventType == 5) {
            emit ActionCommitted(value.matchId, value.round, value.player, value.commitment);
        } else if (value.eventType == 6) {
            emit ActionRevealed(value.matchId, value.round, value.player, value.actions, value.salt);
        } else if (value.eventType == 7) {
            emit PhaseAdvanced(
                value.matchId, value.round, value.fromPhase, value.toPhase, value.deadline
            );
        } else if (value.eventType == 8) {
            emit RoundResolved(
                value.matchId,
                value.round,
                value.beforeHash,
                value.afterHash,
                value.state,
                value.effects
            );
        } else if (value.eventType == 9) {
            emit MatchFinished(
                value.matchId,
                value.round,
                value.winner,
                value.state.battleStarted,
                value.state.completedRound,
                value.state.outcome,
                value.state.reason,
                value.afterHash
            );
        } else {
            revert SquadCodec.InvalidProtocol();
        }
    }
}

contract CompareSquadProtocol {
    IProtocolVm private constant VM = IProtocolVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    struct Entry {
        uint8 kind;
        bytes payload;
    }

    function run(string calldata inputPath, string calldata outputPath)
        external
        returns (uint256 cases)
    {
        // Existing simulation-directory permissions keep these fixtures outside published data.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        Entry[] memory entries = abi.decode(VM.readFileBinary(inputPath), (Entry[]));
        cases = entries.length;
        if (cases == 0) revert SquadCodec.InvalidProtocol();
        SquadProtocolProbe probe = new SquadProtocolProbe();
        // Append results so large fixed-vector batches do not build one quadratic string.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        VM.writeFile(outputPath, "");
        for (uint256 index = 0; index < cases; ++index) {
            if (entries[index].kind == 10) {
                entries[index].payload = abi.encode(
                    address(new SquadProtocolProbe()), abi.decode(entries[index].payload, (bytes32))
                );
            }
            VM.recordLogs();
            string memory result;
            // forge-lint: disable-next-line(calls-loop)
            try probe.evaluate(entries[index].kind, entries[index].payload) returns (
                bytes memory encoded
            ) {
                IDevVm.Log[] memory logs = VM.getRecordedLogs();
                bytes32 digest = bytes32(0);
                bytes32[] memory topics = new bytes32[](0);
                if (entries[index].kind == 5) {
                    if (logs.length != 1) revert SquadCodec.InvalidProtocol();
                    encoded = logs[0].data;
                    topics = logs[0].topics;
                } else {
                    digest = entries[index].kind == 0
                        ? abi.decode(encoded, (bytes32))
                        : keccak256(encoded);
                }
                result = string.concat(
                    '{"accepted":true,"encoding":"',
                    VM.toString(encoded),
                    '","hash":"',
                    VM.toString(digest),
                    '","topics":['
                );
                for (uint256 topic = 0; topic < topics.length; ++topic) {
                    result = string.concat(
                        result, topic == 0 ? "" : ",", '"', VM.toString(topics[topic]), '"'
                    );
                }
                result = string.concat(result, "]}");
            } catch (bytes memory reason) {
                result = string.concat('{"accepted":false,"rejection":"', VM.toString(reason), '"}');
            }
            // forge-lint: disable-next-line(unsafe-cheatcode)
            VM.writeLine(outputPath, result);
        }
    }
}
// forge-lint: disable-end(multi-contract-file,calls-loop,require-revert-in-loop,literal-instead-of-constant)
