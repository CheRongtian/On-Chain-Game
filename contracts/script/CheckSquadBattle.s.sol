// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "../src/SquadCodec.sol";
import { SquadBattleResolver } from "../src/SquadBattleResolver.sol";
import { SquadRules } from "../src/SquadRules.sol";
import { IDevVm } from "./IDevVm.sol";

// The pure probe and offline runner share this fixture-only file.
// forge-lint: disable-start(multi-contract-file,calls-loop,require-revert-in-loop)
interface IBattleVm is IDevVm {
    function writeLine(string calldata path, string calldata data) external;
}

contract SquadBattleProbe {
    uint256 private constant SQUAD_SIZE = 3;

    struct Input {
        SquadCodec.Context context;
        SquadCodec.State state;
        SquadCodec.Action[SQUAD_SIZE][2] actions;
    }

    struct Output {
        SquadCodec.State next;
        SquadCodec.Effects effects;
        SquadBattleResolver.Checkpoints trace;
        SquadCodec.State initial;
        SquadCodec.Action[SQUAD_SIZE][2] actions;
        bytes beforeEncoding;
        bytes afterEncoding;
        bytes32 beforeHash;
        bytes32 stateHash;
        uint256 resolveGas;
        uint256 hashGas;
    }

    struct Sequence {
        SquadCodec.Context context;
        SquadCodec.State state;
        SquadCodec.Action[SQUAD_SIZE][2][] steps;
    }

    struct StepResult {
        bool accepted;
        bytes result;
    }

    function evaluate(uint8 kind, bytes calldata payload) external view returns (bytes memory) {
        if (kind == 2) return _sequence(abi.decode(payload, (Sequence)));
        if (kind == 3) return _protocolIsolation(abi.decode(payload, (Input)));
        if (kind > 1) revert SquadCodec.InvalidProtocol();
        Input memory input = abi.decode(payload, (Input));
        SquadCodec.Action[SQUAD_SIZE][2] memory collected;
        // Collect B first or A first while retaining their fixed side/slot identities.
        uint256 first = kind;
        for (uint256 slot = 0; slot < SQUAD_SIZE; ++slot) {
            collected[first][slot] = input.actions[first][slot];
        }
        for (uint256 slot = 0; slot < SQUAD_SIZE; ++slot) {
            collected[1 - first][slot] = input.actions[1 - first][slot];
        }
        Output memory output;
        // Measure only the actual internal calls, excluding decoding, output encoding and fixture I/O.
        uint256 beforeGas = gasleft();
        (output.next, output.effects, output.trace) =
            SquadBattleResolver.resolve(input.state, collected);
        output.resolveGas = beforeGas - gasleft();
        beforeGas = gasleft();
        output.stateHash = SquadRules.hashState(input.context, output.next);
        output.hashGas = beforeGas - gasleft();
        output.beforeHash = SquadRules.hashState(input.context, input.state);
        bytes32 ruleset = SquadRules.rulesetId();
        output.beforeEncoding =
            SquadCodec.stateEncoding(SquadCodec.StateInput(input.context, ruleset, input.state));
        output.afterEncoding =
            SquadCodec.stateEncoding(SquadCodec.StateInput(input.context, ruleset, output.next));
        // Return caller memory after calculation and hashing to detect input aliases.
        output.initial = input.state;
        output.actions = input.actions;
        return abi.encode(output);
    }

    function _sequence(Sequence memory input) private view returns (bytes memory) {
        SquadCodec.State memory current = input.state;
        StepResult[] memory results = new StepResult[](input.steps.length);
        for (uint256 index = 0; index < input.steps.length; ++index) {
            try this.evaluate(
                0,
                abi.encode(
                    Input({ context: input.context, state: current, actions: input.steps[index] })
                )
            ) returns (
                bytes memory encoded
            ) {
                Output memory output = abi.decode(encoded, (Output));
                current = output.next;
                results[index] = StepResult({ accepted: true, result: encoded });
            } catch (bytes memory reason) {
                results[index] = StepResult({ accepted: false, result: reason });
            }
        }
        return abi.encode(results, current, input.state);
    }

    function _protocolIsolation(Input memory input) private pure returns (bytes memory) {
        SquadCodec.MatchData memory room;
        room.battle = input.state;
        bytes32 beforeHash = SquadRules.hashState(input.context, room.battle);
        room.summary.phase = 5;
        room.summary.activeRound = 17;
        room.summary.joinDeadline = 111;
        room.summary.phaseDeadline = 222;
        room.squad.commitments[0] = bytes32(uint256(1));
        room.squad.committed[0] = true;
        room.squad.revealed[0] = true;
        room.turn.commitments[1] = bytes32(uint256(2));
        room.turn.committed[1] = true;
        room.turn.revealed[1] = true;
        room.revealedActions[0] = 1;
        return abi.encode(beforeHash, SquadRules.hashState(input.context, room.battle));
    }
}

contract CheckSquadBattle {
    IBattleVm private constant VM = IBattleVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    struct Entry {
        uint8 kind;
        bytes payload;
    }

    function run(string calldata inputPath, string calldata outputPath)
        external
        returns (uint256 cases)
    {
        // Fixture I/O uses the existing simulation-directory permissions.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        Entry[] memory entries = abi.decode(VM.readFileBinary(inputPath), (Entry[]));
        if (entries.length == 0) revert SquadCodec.InvalidProtocol();
        cases = entries.length;
        SquadBattleProbe probe = new SquadBattleProbe();
        // forge-lint: disable-next-line(unsafe-cheatcode)
        VM.writeFile(outputPath, "");
        for (uint256 index = 0; index < cases; ++index) {
            string memory result;
            try probe.evaluate(entries[index].kind, entries[index].payload) returns (
                bytes memory encoded
            ) {
                result = string.concat('{"accepted":true,"encoding":"', VM.toString(encoded), '"}');
            } catch (bytes memory reason) {
                result = string.concat('{"accepted":false,"rejection":"', VM.toString(reason), '"}');
            }
            // forge-lint: disable-next-line(unsafe-cheatcode)
            VM.writeLine(outputPath, result);
        }
    }
}
// forge-lint: disable-end(multi-contract-file,calls-loop,require-revert-in-loop)
