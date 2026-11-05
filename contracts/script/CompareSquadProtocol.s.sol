// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "../src/SquadCodec.sol";
import { ISquadEvents } from "../src/ISquadArena.sol";
import { IDevVm } from "./IDevVm.sol";

// Fixture IDs are fixed by the shared corpus; every case records and writes its emitted log.
// forge-lint: disable-start(multi-contract-file,calls-loop,require-revert-in-loop,literal-instead-of-constant)

interface IProtocolVm is IDevVm {
    function writeLine(string calldata path, string calldata data) external;
}

contract SquadProtocolProbe is ISquadEvents {
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
        if (kind != 5) revert SquadCodec.InvalidProtocol();
        _emitEvent(abi.decode(payload, (EventInput)));
        return "";
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
