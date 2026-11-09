// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

// Array positions follow the frozen ruleFields in the protocol configuration.
// forge-lint: disable-start(literal-instead-of-constant)
library SquadParameters {
    error InvalidProtocol();

    uint8 internal constant SQUAD_SIZE = 3;
    uint8 internal constant UNIT_COUNT = 6;
    uint8 internal constant TYPE_COUNT = 5;
    uint8 internal constant MAP_COUNT = 3;
    uint8 internal constant BOARD_WIDTH = 8;
    uint8 internal constant CELL_COUNT = 64;
    uint8 internal constant UNUSED_CELL = 255;
    uint8 internal constant INITIAL_ENERGY = 2;
    uint8 internal constant MAX_ENERGY = 5;
    uint8 internal constant MAX_ROUNDS = 20;
    uint64 private constant RESOURCES_MASK = 0x0000_2000_0004_0000;
    uint64 private constant CONTROL_MASK = 0x0000_0018_1800_0000;
    bytes32 internal constant SEMANTICS_ID =
        0x5531fbb3476650deb52c266f8091522a428ead5d2a1f696b1b3b49f7866a930b;

    function matchRules() internal pure returns (uint8[8] memory) {
        return [INITIAL_ENERGY, MAX_ENERGY, 0, 1, 2, 4, 12, MAX_ROUNDS];
    }

    function unitRules() internal pure returns (uint8[5][5] memory) {
        return [
            [uint8(10), 1, 1, 2, 1],
            [uint8(6), 2, 3, 2, 2],
            [uint8(5), 3, 1, 1, 1],
            [uint8(7), 2, 1, 1, 2],
            [uint8(6), 2, 1, 1, 2]
        ];
    }

    function unitRule(uint8 unitType) internal pure returns (uint8[5] memory) {
        // Invalid type codes must reject even when this lookup is used in a fixed-size loop.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (unitType == 0 || unitType > TYPE_COUNT) revert InvalidProtocol();
        return unitRules()[unitType - 1];
    }

    function skillRules() internal pure returns (uint8[10] memory) {
        return [uint8(2), 3, 4, 2, 2, 2, 1, 1, 1, 0];
    }

    function windows() internal pure returns (uint32[5] memory) {
        return [uint32(1 days), 10 minutes, 10 minutes, 10 minutes, 10 minutes];
    }

    function schemas() internal pure returns (uint16[3] memory) {
        return [uint16(2), 2, 2];
    }

    function terrain(uint8 mapId) internal pure returns (uint64[4] memory) {
        // Direct map lookups and catalogue loops share the same bounds check.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (mapId == 0 || mapId > MAP_COUNT) revert InvalidProtocol();
        if (mapId == 1) {
            return
                [uint64(0x0000_4200_0042_0000), 0x0000_0404_2020_0000, RESOURCES_MASK, CONTROL_MASK];
        }
        if (mapId == 2) {
            return
                [uint64(0x0030_0022_4400_0c00), 0x0000_1004_2008_0000, RESOURCES_MASK, CONTROL_MASK];
        }
        return [uint64(0x0010_0044_2200_0800), 0x0000_4800_0012_0000, RESOURCES_MASK, CONTROL_MASK];
    }

    function spawnsA() internal pure returns (uint8[3] memory) {
        return [uint8(8), 24, 40];
    }

    function spawnsB() internal pure returns (uint8[3] memory) {
        return [uint8(55), 39, 23];
    }
}
// forge-lint: disable-end(literal-instead-of-constant)
