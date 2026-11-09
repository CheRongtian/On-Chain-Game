// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "../src/SquadCodec.sol";
import { SquadBattleResolver } from "../src/SquadBattleResolver.sol";
import { IDevVm } from "./IDevVm.sol";

// The pure probe and offline runner share this fixture-only file.
// forge-lint: disable-start(multi-contract-file,calls-loop,require-revert-in-loop)
interface IBattleVm is IDevVm {
    function writeLine(string calldata path, string calldata data) external;
}

contract SquadBattleProbe {
    uint256 private constant SQUAD_SIZE = 3;

    struct Input {
        SquadCodec.State state;
        SquadCodec.Action[SQUAD_SIZE][2] actions;
    }

    function evaluate(uint8 kind, bytes calldata payload) external pure returns (bytes memory) {
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
        (
            SquadCodec.State memory next,
            SquadCodec.Effects memory effects,
            SquadBattleResolver.Checkpoints memory trace
        ) = SquadBattleResolver.resolve(input.state, collected);
        SquadCodec.validateState(next);
        // Return caller memory after the actual calculation to detect input aliases.
        return abi.encode(next, effects, trace, input.state, input.actions);
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
