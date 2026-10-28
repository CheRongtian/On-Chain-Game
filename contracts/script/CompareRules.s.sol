// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "../src/GameTypes.sol";
import { GameHash } from "../src/GameHash.sol";
import { BattleProbe } from "./BattleProbe.sol";
import { IDevVm } from "./IDevVm.sol";

// This script runs only inside Forge's offline EVM and never broadcasts a transaction.
contract CompareRules {
    IDevVm private constant VM = IDevVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    uint256 private constant ABI_WORD_BYTES = 32;

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
        uint256 index = 0;
        for (; index < cases; ++index) {
            ProtocolVector memory entry = vectors.cases[index];
            bytes memory actual = abi.encode(entry.actions);
            ComparisonResult memory comparison = _compare(actual, entry.expectedEncoding);
            if (!comparison.matched) {
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
        uint256 index = 0;
        ComparisonResult memory result;
        for (; index < cases; ++index) {
            result = _check(probe, entries[index]);
            if (!result.matched) break;
        }
        if (index < cases) {
            // forge-lint: disable-next-line(unsafe-cheatcode)
            VM.writeFile(reportPath, _report(index, result));
        } else {
            // forge-lint: disable-next-line(unsafe-cheatcode)
            VM.writeFile(reportPath, '{"matched":true}');
        }
    }

    function _check(BattleProbe probe, Comparison memory entry)
        private
        pure
        returns (ComparisonResult memory result)
    {
        // The freshly deployed pure probe provides a revert boundary for each offline case.
        // forge-lint: disable-next-line(calls-loop)
        try probe.resolve(entry.state, entry.actionsA, entry.actionsB) returns (
            GameTypes.BattleState memory next, GameTypes.ResolutionSummary memory summary
        ) {
            result = _compare(
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
        returns (ComparisonResult memory result)
    {
        if (actual.length != expected.length) {
            result.expected = bytes32(expected.length);
            result.actual = bytes32(actual.length);
            return result;
        }
        for (uint256 offset = 0; offset < actual.length; offset += ABI_WORD_BYTES) {
            bytes32 got = bytes32(0);
            bytes32 want = bytes32(0);
            // The actual input is ABI-encoded; equal lengths keep both word reads within bounds.
            // forge-lint: disable-next-line(inline-assembly)
            assembly ("memory-safe") {
                got := mload(add(add(actual, ABI_WORD_BYTES), offset))
                want := mload(add(add(expected, ABI_WORD_BYTES), offset))
            }
            if (got != want) {
                result.word = offset / ABI_WORD_BYTES;
                result.expected = want;
                result.actual = got;
                return result;
            }
        }
        result.matched = true;
    }
}
