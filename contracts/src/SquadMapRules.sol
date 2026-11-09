// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "./SquadCodec.sol";
import { SquadParameters as Parameters } from "./SquadParameters.sol";

library SquadMapRules {
    uint8 private constant CELL_BITS = 6;
    uint32 private constant CELL_MASK = Parameters.CELL_COUNT - 1;

    function cellId(uint8 x, uint8 y) internal pure returns (uint8) {
        if (x >= Parameters.BOARD_WIDTH || y >= Parameters.BOARD_WIDTH) {
            revert SquadCodec.InvalidProtocol();
        }
        return y * Parameters.BOARD_WIDTH + x;
    }

    function coordinates(uint8 cell) internal pure returns (uint8 x, uint8 y) {
        if (cell >= Parameters.CELL_COUNT) revert SquadCodec.InvalidProtocol();
        return (cell % Parameters.BOARD_WIDTH, cell / Parameters.BOARD_WIDTH);
    }

    function contains(uint64 mask, uint8 cell) internal pure returns (bool) {
        return cell < Parameters.CELL_COUNT && (mask & (uint64(1) << cell)) != 0;
    }

    function isAdjacent(uint8 from, uint8 target) internal pure returns (bool) {
        if (from >= Parameters.CELL_COUNT || target >= Parameters.CELL_COUNT) return false;
        uint8 width = Parameters.BOARD_WIDTH;
        return (from / width == target / width && distance(from % width, target % width) == 1)
            || (from % width == target % width && distance(from / width, target / width) == 1);
    }

    function isValidPath(uint8 start, uint8 length, uint32 bits, uint8 limit, uint64 blocked)
        internal
        pure
        returns (bool)
    {
        if (start >= Parameters.CELL_COUNT || length == 0 || length > limit || length > 4) {
            return false;
        }
        if (uint256(bits) >> (uint256(length) * CELL_BITS) != 0) return false;
        uint64 visited = uint64(1) << start;
        uint8 previous = start;
        for (uint8 step = 0; step < length; ++step) {
            // The mask bounds the decoded cell to six bits.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8 cell = uint8((bits >> (uint256(step) * CELL_BITS)) & CELL_MASK);
            if (!isAdjacent(previous, cell) || contains(blocked | visited, cell)) return false;
            visited |= uint64(1) << cell;
            previous = cell;
        }
        return true;
    }

    function isClearRay(uint8 from, uint8 target, uint8 range, uint64 obstacles)
        internal
        pure
        returns (bool)
    {
        if (
            from >= Parameters.CELL_COUNT || target >= Parameters.CELL_COUNT || from == target
                || contains(obstacles, from)
        ) return false;
        uint8 width = Parameters.BOARD_WIDTH;
        bool sameRow = from / width == target / width;
        if (!sameRow && from % width != target % width) return false;
        uint8 length = sameRow
            ? distance(from % width, target % width)
            : distance(from / width, target / width);
        if (length > range) return false;
        uint8 stride = sameRow ? 1 : width;
        uint8 cell = from;
        for (uint8 step = 0; step < length; ++step) {
            cell = from < target ? cell + stride : cell - stride;
            if (contains(obstacles, cell)) return false;
        }
        return true;
    }

    function distance(uint8 a, uint8 b) private pure returns (uint8) {
        return a > b ? a - b : b - a;
    }
}
