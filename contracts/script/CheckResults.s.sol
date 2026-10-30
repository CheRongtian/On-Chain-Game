// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "../src/GameTypes.sol";
import { GameHash } from "../src/GameHash.sol";
import { ResultRules } from "../src/ResultRules.sol";
import { IDevVm } from "./IDevVm.sol";

contract CheckResults {
    IDevVm private constant VM = IDevVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    // Typed decoding preserves ABI field order and fixed array lengths.
    string private constant VECTOR_SCHEMA = "StateVectors(bytes32 rulesHash,ResultVector[] results,HashVector[] hashes)"
        "BattleState(uint8 mapId,uint8 round,PlayerState[2] players,"
        "UnitState[6] units,uint8 outcome,uint8 reason)"
        "HashVector(string name,MatchContext context,BattleState state,bytes32 expectedHash)"
        "MatchContext(uint256 chainId,address arena,uint256 matchId)"
        "PlayerState(uint8 energy,uint8 victoryPoints)"
        "ResultVector(string name,BattleState state,uint8 expectedOutcome,uint8 expectedReason)"
        "UnitState(uint8 unitType,uint8 cell,uint8 hp)";

    struct ResultVector {
        string name;
        GameTypes.BattleState state;
        GameTypes.Outcome expectedOutcome;
        GameTypes.EndReason expectedReason;
    }

    struct HashVector {
        string name;
        GameTypes.MatchContext context;
        GameTypes.BattleState state;
        bytes32 expectedHash;
    }

    struct StateVectors {
        bytes32 rulesHash;
        ResultVector[] results;
        HashVector[] hashes;
    }

    function run() external view returns (uint256 resultCases, uint256 hashCases) {
        // Only the fixed fixture file is read, under foundry.toml's read permission.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = VM.readFile("../config/state-vectors.json");
        StateVectors memory vectors =
            abi.decode(VM.parseJsonType(json, VECTOR_SCHEMA), (StateVectors));
        require(vectors.rulesHash == GameHash.rulesHash(), "Frozen rules hash differs");
        resultCases = vectors.results.length;
        hashCases = vectors.hashes.length;
        require(resultCases != 0 && hashCases != 0, "State vectors are empty");

        _checkResults(vectors.results);
        _checkHashes(vectors.hashes);
        require(
            GameHash.hashBattleState(vectors.hashes[0].context, GameTypes.initialBattleState())
                == vectors.hashes[0].expectedHash,
            "Initial state differs from the fixed vector"
        );
    }

    function _checkResults(ResultVector[] memory vectors) private pure {
        uint256 index = 0;
        GameTypes.Outcome outcome = GameTypes.Outcome.None;
        GameTypes.EndReason reason = GameTypes.EndReason.None;
        for (; index < vectors.length; ++index) {
            // Malformed fixtures must stop at the production state validator.
            (outcome, reason) = ResultRules.evaluate(vectors[index].state);
            if (
                outcome != vectors[index].expectedOutcome || reason != vectors[index].expectedReason
            ) break;
        }
        if (index < vectors.length) {
            revert(string.concat("Result vector differs: ", vectors[index].name));
        }
    }

    function _checkHashes(HashVector[] memory vectors) private pure {
        uint256 index = 0;
        for (; index < vectors.length; ++index) {
            // Each canonical state is checked against its independently encoded digest.
            bytes32 actual = GameHash.hashBattleState(vectors[index].context, vectors[index].state);
            if (actual != vectors[index].expectedHash) break;
        }
        if (index < vectors.length) {
            revert(string.concat("State hash vector differs: ", vectors[index].name));
        }
    }
}
