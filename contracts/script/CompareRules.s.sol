// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "../src/GameTypes.sol";
import { GameHash } from "../src/GameHash.sol";
import { BattleProbe } from "./BattleProbe.sol";
import { IDevVm } from "./IDevVm.sol";

interface IOfflineVm is IDevVm {
    function readFileBinary(string calldata path) external view returns (bytes memory);
    function writeFile(string calldata path, string calldata data) external;
    function toString(uint256 value) external pure returns (string memory);
    function toString(bytes32 value) external pure returns (string memory);
    function toString(bytes calldata value) external pure returns (string memory);
}

// This script runs only inside Forge's offline EVM and never broadcasts a transaction.
contract CompareRules {
    IOfflineVm private constant VM = IOfflineVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    struct Comparison {
        GameTypes.MatchContext context;
        GameTypes.BattleState state;
        GameTypes.Action[3] actionsA;
        GameTypes.Action[3] actionsB;
        GameTypes.BattleState expectedState;
        GameTypes.ResolutionSummary expectedSummary;
        bytes32 expectedHash;
    }

    struct ProtocolVector {
        string name;
        GameTypes.MatchContext context;
        uint8 round;
        address player;
        GameTypes.Action[3] actions;
        bytes32 salt;
        bytes expectedEncoding;
        bytes32 expectedActionsHash;
        bytes32 expectedCommitment;
    }

    struct ProtocolVectors {
        bytes32 rulesHash;
        ProtocolVector[] cases;
    }

    struct ComparisonResult {
        bool matched;
        uint256 word;
        bytes32 expected;
        bytes32 actual;
        bool rejected;
        bytes reason;
    }

    string private constant PROTOCOL_SCHEMA = "ProtocolVectors(bytes32 rulesHash,ProtocolVector[] cases)"
        "Action(uint8 kind,uint8 targetCell,uint8 pathLength,uint8[4] path)"
        "MatchContext(uint256 chainId,address arena,uint256 matchId)"
        "ProtocolVector(string name,MatchContext context,uint8 round,address player,"
        "Action[3] actions,bytes32 salt,bytes expectedEncoding,bytes32 expectedActionsHash,"
        "bytes32 expectedCommitment)";

    function protocol() external view returns (uint256 cases) {
        // This fixed reference file is explicitly permitted by foundry.toml.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = VM.readFile("../config/protocol-vectors.json");
        ProtocolVectors memory vectors =
            abi.decode(VM.parseJsonType(json, PROTOCOL_SCHEMA), (ProtocolVectors));
        require(vectors.rulesHash == GameHash.rulesHash(), "Protocol rules hash differs");
        cases = vectors.cases.length;
        require(cases > 0, "Protocol vectors are empty");
        string memory failure = "";
        uint256 index;
        for (; index < cases; ++index) {
            ProtocolVector memory entry = vectors.cases[index];
            bytes memory actual = abi.encode(entry.actions);
            (bool equal,,,) = _compare(actual, entry.expectedEncoding);
            if (!equal) {
                failure = "action encoding differs";
            } else if (GameHash.hashActions(entry.actions) != entry.expectedActionsHash) {
                failure = "actions hash differs";
            } else if (
                GameHash.actionCommitment(
                        entry.context, entry.round, entry.player, entry.actions, entry.salt
                    ) != entry.expectedCommitment
            ) {
                failure = "commitment differs";
            }
            if (bytes(failure).length != 0) break;
        }
        if (index < cases) {
            revert(string.concat("Protocol vector ", vectors.cases[index].name, ": ", failure));
        }
    }

    function run(string calldata inputPath, string calldata reportPath)
        external
        returns (uint256 cases)
    {
        // The generated inputs and report stay inside the launcher's local simulation directory.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        bytes memory input = VM.readFileBinary(inputPath);
        Comparison[] memory entries = abi.decode(input, (Comparison[]));
        cases = entries.length;
        require(cases > 0, "Comparison inputs are empty");
        BattleProbe probe = new BattleProbe();
        for (uint256 index; index < cases; ++index) {
            ComparisonResult memory result = _check(probe, entries[index]);
            if (!result.matched) {
                // forge-lint: disable-next-line(unsafe-cheatcode)
                VM.writeFile(reportPath, _report(index, result));
                return cases;
            }
        }
        // forge-lint: disable-next-line(unsafe-cheatcode)
        VM.writeFile(reportPath, '{"matched":true}');
    }

    function _check(BattleProbe probe, Comparison memory entry)
        private
        pure
        returns (ComparisonResult memory result)
    {
        try probe.resolve(entry.state, entry.actionsA, entry.actionsB) returns (
            GameTypes.BattleState memory next, GameTypes.ResolutionSummary memory summary
        ) {
            (result.matched, result.word, result.expected, result.actual) = _compare(
                abi.encode(next, summary, GameHash.hashBattleState(entry.context, next)),
                abi.encode(entry.expectedState, entry.expectedSummary, entry.expectedHash)
            );
        } catch (bytes memory reason) {
            result.rejected = true;
            result.reason = reason;
        }
    }

    function _report(uint256 index, ComparisonResult memory result)
        private
        pure
        returns (string memory)
    {
        string memory prefix = string.concat('{"matched":false,"caseIndex":', VM.toString(index));
        if (result.rejected) {
            return
                string.concat(
                    prefix, ',"rejected":true,"error":"', VM.toString(result.reason), '"}'
                );
        }
        prefix = string.concat(prefix, ',"word":', VM.toString(result.word));
        return string.concat(
            prefix,
            ',"expected":"',
            VM.toString(result.expected),
            '","actual":"',
            VM.toString(result.actual),
            '"}'
        );
    }

    function _compare(bytes memory actual, bytes memory expected)
        private
        pure
        returns (bool equal, uint256 word, bytes32 want, bytes32 got)
    {
        if (actual.length != expected.length) {
            return (false, 0, bytes32(expected.length), bytes32(actual.length));
        }
        for (uint256 offset; offset < actual.length; offset += 32) {
            assembly ("memory-safe") {
                got := mload(add(add(actual, 32), offset))
                want := mload(add(add(expected, 32), offset))
            }
            if (got != want) return (false, offset / 32, want, got);
        }
        return (true, 0, bytes32(0), bytes32(0));
    }
}
