// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "./GameTypes.sol";
import { IArena } from "./IArena.sol";

library MapRules {
    function requireKnownMap(uint8 mapId) internal pure {
        if (mapId != GameTypes.MAP_ID) revert IArena.UnknownMap(mapId);
    }

    function getMap(uint8 mapId) internal pure returns (GameTypes.MapConfig memory) {
        requireKnownMap(mapId);
        return GameTypes.defaultMap();
    }

    function cellId(uint8 x, uint8 y) internal pure returns (uint8) {
        if (x >= GameTypes.BOARD_SIZE || y >= GameTypes.BOARD_SIZE) {
            revert IArena.InvalidCoordinates(x, y);
        }
        return y * GameTypes.BOARD_SIZE + x;
    }

    function coordinates(uint8 cell) internal pure returns (uint8 x, uint8 y) {
        if (cell >= GameTypes.CELL_COUNT) revert IArena.InvalidCell(cell);
        return (cell % GameTypes.BOARD_SIZE, cell / GameTypes.BOARD_SIZE);
    }

    function contains(uint64 bitmap, uint8 cell) internal pure returns (bool) {
        return cell < GameTypes.CELL_COUNT && (bitmap & (uint64(1) << cell)) != 0;
    }

    function isAdjacent(uint8 from, uint8 to) internal pure returns (bool) {
        if (from >= GameTypes.CELL_COUNT || to >= GameTypes.CELL_COUNT) return false;
        uint8 fromX = from % GameTypes.BOARD_SIZE;
        uint8 fromY = from / GameTypes.BOARD_SIZE;
        uint8 toX = to % GameTypes.BOARD_SIZE;
        uint8 toY = to / GameTypes.BOARD_SIZE;
        return (fromX == toX && _distance(fromY, toY) == 1)
            || (fromY == toY && _distance(fromX, toX) == 1);
    }

    // blocked contains walls and every live unit's round-start cell.
    function isValidPath(
        uint8 start,
        uint8 pathLength,
        uint8[4] memory path,
        uint8 limit,
        uint64 blocked
    ) internal pure returns (bool) {
        if (
            start >= GameTypes.CELL_COUNT || pathLength == 0 || pathLength > limit
                || pathLength > GameTypes.MAX_PATH_LENGTH
        ) return false;

        uint64 visited = uint64(1) << start;
        uint8 previous = start;
        for (uint8 step = 0; step < pathLength; ++step) {
            uint8 cell = path[step];
            if (!isAdjacent(previous, cell) || contains(blocked | visited, cell)) return false;
            visited |= uint64(1) << cell;
            previous = cell;
        }
        return true;
    }

    // Walls block the ray, including its target cell. Units do not block it.
    function isClearRay(uint8 from, uint8 target, uint8 range, uint64 obstacles)
        internal
        pure
        returns (bool)
    {
        if (
            from >= GameTypes.CELL_COUNT || target >= GameTypes.CELL_COUNT || from == target
                || contains(obstacles, from)
        ) return false;

        bool sameRow = from / GameTypes.BOARD_SIZE == target / GameTypes.BOARD_SIZE;
        if (!sameRow && from % GameTypes.BOARD_SIZE != target % GameTypes.BOARD_SIZE) {
            return false;
        }
        uint8 distance = sameRow
            ? _distance(from, target)
            : _distance(from / GameTypes.BOARD_SIZE, target / GameTypes.BOARD_SIZE);
        if (distance > range) return false;

        uint8 stride = sameRow ? 1 : GameTypes.BOARD_SIZE;
        uint8 cell = from;
        for (uint8 step = 0; step < distance; ++step) {
            cell = from < target ? cell + stride : cell - stride;
            if (contains(obstacles, cell)) return false;
        }
        return true;
    }

    function _distance(uint8 a, uint8 b) private pure returns (uint8) {
        return a > b ? a - b : b - a;
    }
}
