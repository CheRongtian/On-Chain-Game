// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "../src/SquadCodec.sol";
import { SquadRules } from "../src/SquadRules.sol";
import { SquadMapRules as Geometry } from "../src/SquadMapRules.sol";
import { SquadUnitRules } from "../src/SquadUnitRules.sol";
import { IDevVm } from "./IDevVm.sol";

// The pure probe and its offline batch runner share this fixture-only file.
// forge-lint: disable-start(multi-contract-file,calls-loop,require-revert-in-loop)
interface IStaticVm is IDevVm {
    function writeLine(string calldata path, string calldata data) external;
}

contract SquadActionsProbe {
    struct ActionInput {
        SquadCodec.State state;
        uint8 side;
        SquadCodec.Action[3] actions;
    }

    function evaluate(uint8 kind, bytes calldata payload) external pure returns (bytes memory) {
        if (kind == 0) {
            ActionInput memory input = abi.decode(payload, (ActionInput));
            uint8 required = SquadUnitRules.validateActions(input.state, input.side, input.actions);
            // Return the same memory values after validation, so accidental mutation fails comparison.
            return abi.encode(required, input.state, input.actions);
        }
        if (kind == 1) {
            (uint8 mapId, uint8 cell) = abi.decode(payload, (uint8, uint8));
            SquadCodec.Map memory map = SquadRules.getMap(mapId);
            (uint8 x, uint8 y) = Geometry.coordinates(cell);
            return abi.encode(
                x,
                y,
                Geometry.cellId(x, y),
                Geometry.contains(map.obstacles, cell),
                Geometry.contains(map.cover, cell),
                Geometry.contains(map.resources, cell),
                Geometry.contains(map.controlZone, cell),
                cell == map.spawnsA[0] || cell == map.spawnsA[1] || cell == map.spawnsA[2],
                cell == map.spawnsB[0] || cell == map.spawnsB[1] || cell == map.spawnsB[2]
            );
        }
        if (kind == 2) {
            (uint8 x, uint8 y) = abi.decode(payload, (uint8, uint8));
            return abi.encode(Geometry.cellId(x, y));
        }
        if (kind == 3) {
            (uint8 mapId, uint8 from, uint8 target, uint8 range) =
                abi.decode(payload, (uint8, uint8, uint8, uint8));
            return abi.encode(
                Geometry.isClearRay(from, target, range, SquadRules.getMap(mapId).obstacles)
            );
        }
        revert SquadCodec.InvalidProtocol();
    }
}

contract CheckSquadActions {
    IStaticVm private constant VM = IStaticVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    struct Entry {
        uint8 kind;
        bytes payload;
    }

    function run(string calldata inputPath, string calldata outputPath)
        external
        returns (uint256 cases)
    {
        // Fixture I/O stays within the existing simulation-directory permissions.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        Entry[] memory entries = abi.decode(VM.readFileBinary(inputPath), (Entry[]));
        if (entries.length == 0) revert SquadCodec.InvalidProtocol();
        cases = entries.length;
        SquadActionsProbe probe = new SquadActionsProbe();
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
