// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "../src/GameTypes.sol";
import { MapRules } from "../src/MapRules.sol";
import { IArena } from "../src/IArena.sol";
import { RulesProbe } from "./RulesProbe.sol";

contract CheckRules {
    uint256 private constant SQUAD_SIZE = 3;
    uint8 private constant GUARDIAN_STEP = 9;
    uint8 private constant GUARDIAN_FAR = 10;
    uint8 private constant UPPER_LANE = 16;
    uint8 private constant WALL_CELL = 17;
    uint8 private constant RANGER_STEP = 25;
    uint8 private constant RANGER_END = 26;
    uint8 private constant RANGER_TARGET = 27;
    uint8 private constant RANGER_FAR = 28;
    uint8 private constant LOWER_LANE = 32;
    uint8 private constant LOWER_TURN = 33;
    uint8 private constant SCOUT_END = 34;
    uint8 private constant DASH_END = 35;

    function run() external {
        RulesProbe probe = new RulesProbe();
        _checkMap(probe);
        _checkBoard(probe);
        _checkMovement(probe);
        _checkMoveLimits(probe);
        _checkBlockedPaths(probe);
        _checkTargets(probe);
        _checkSkillsAndBudgets(probe);
        _checkDeadSlots(probe);
        _checkEncoding(probe);
    }

    function _checkMap(RulesProbe probe) private {
        GameTypes.MapConfig memory map = MapRules.getMap(GameTypes.MAP_ID);
        require(
            map.obstacles == 0x0000_4200_0042_0000 && map.resources == 0x0000_2000_0004_0000
                && map.controlZone == 0x0000_0018_1800_0000,
            "Map bitmaps differ"
        );
        require(MapRules.cellId(0, 0) == 0, "Board origin differs");
        uint8 last = GameTypes.BOARD_SIZE - 1;
        require(MapRules.cellId(last, last) == GameTypes.CELL_COUNT - 1, "Board corner differs");
        (uint8 x, uint8 y) = MapRules.coordinates(map.spawnsA[0]);
        require(x == 0 && y == 1, "Spawn coordinates differ");
        require(
            !MapRules.isAdjacent(last, GameTypes.BOARD_SIZE), "Row wrap was considered adjacent"
        );
        _expectRevert(
            probe,
            abi.encodeCall(RulesProbe.cellId, (GameTypes.BOARD_SIZE, uint8(0))),
            abi.encodeWithSelector(IArena.InvalidCoordinates.selector, GameTypes.BOARD_SIZE, 0)
        );
        _expectRevert(
            probe,
            abi.encodeCall(RulesProbe.coordinates, (GameTypes.CELL_COUNT)),
            abi.encodeWithSelector(IArena.InvalidCell.selector, GameTypes.CELL_COUNT)
        );
    }

    function _checkBoard(RulesProbe probe) private {
        GameTypes.BattleState memory state = GameTypes.initialBattleState();
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        require(probe.validateActions(state, 0, actions) == 0, "Initial squad A differs");
        require(probe.validateActions(state, 1, actions) == 0, "Initial squad B differs");
        actions[1] = _attack(GameTypes.CELL_COUNT - 1);
        require(probe.validateActions(state, 1, actions) == 0, "Squad B used the wrong unit slot");
        actions[1] = _attack(GameTypes.BOARD_SIZE - 1);
        _reject(
            probe,
            state,
            1,
            actions,
            abi.encodeWithSelector(IArena.InvalidTarget.selector, GameTypes.SQUAD_SIZE + 1)
        );
        actions = _holds();
        _reject(
            probe,
            state,
            2,
            actions,
            abi.encodeWithSelector(IArena.InvalidPlayerState.selector, uint8(2))
        );
        state.units[1].cell = state.units[0].cell;
        _reject(
            probe,
            state,
            0,
            actions,
            abi.encodeWithSelector(IArena.InvalidUnitState.selector, uint8(1))
        );
        state = GameTypes.initialBattleState();
        state.units[0].cell = WALL_CELL;
        _reject(
            probe,
            state,
            0,
            actions,
            abi.encodeWithSelector(IArena.InvalidUnitState.selector, uint8(0))
        );
    }

    function _checkMovement(RulesProbe probe) private pure {
        GameTypes.BattleState memory state = GameTypes.initialBattleState();
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        actions[0] = _move(1, [GUARDIAN_STEP, 0, 0, 0]);
        actions[1] = _move(2, [RANGER_STEP, RANGER_END, 0, 0]);
        actions[2] = _move(GameTypes.SCOUT_MOVE_RANGE, [LOWER_LANE, LOWER_TURN, SCOUT_END, 0]);
        require(probe.validateActions(state, 0, actions) == 0, "Valid movement was rejected");

        // Shared endpoints and intermediate cells are legal during static validation.
        actions = _holds();
        actions[1] = _move(1, [LOWER_LANE, 0, 0, 0]);
        actions[2] = _move(1, [LOWER_LANE, 0, 0, 0]);
        require(probe.validateActions(state, 0, actions) == 0, "Shared endpoint rejected early");
        actions[1] = _move(2, [LOWER_LANE, LOWER_TURN, 0, 0]);
        actions[2] = _move(GameTypes.SCOUT_MOVE_RANGE, [LOWER_LANE, LOWER_TURN, SCOUT_END, 0]);
        require(probe.validateActions(state, 0, actions) == 0, "Shared intermediate cells rejected");
    }

    function _checkMoveLimits(RulesProbe probe) private {
        GameTypes.BattleState memory state = GameTypes.initialBattleState();
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        actions[0] = _move(2, [GUARDIAN_STEP, GUARDIAN_FAR, 0, 0]);
        _rejectPath(probe, state, actions, 0);
        actions = _holds();
        actions[1] = _move(GameTypes.SCOUT_MOVE_RANGE, [RANGER_STEP, RANGER_END, RANGER_TARGET, 0]);
        _rejectPath(probe, state, actions, 1);
        actions = _holds();
        actions[2] = _move(GameTypes.MAX_PATH_LENGTH, [LOWER_LANE, LOWER_TURN, SCOUT_END, DASH_END]);
        _rejectPath(probe, state, actions, 2);
        actions[2].kind = GameTypes.ActionKind.Dash;
        require(probe.validateActions(state, 0, actions) == 1, "Valid Dash was rejected");
    }

    function _checkBlockedPaths(RulesProbe probe) private {
        GameTypes.BattleState memory state = GameTypes.initialBattleState();
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        actions[1] = _move(2, [UPPER_LANE, WALL_CELL, 0, 0]);
        _rejectPath(probe, state, actions, 1);
        actions = _holds();
        actions[2] = _move(GameTypes.SCOUT_MOVE_RANGE, [LOWER_LANE, LOWER_TURN, LOWER_LANE, 0]);
        _rejectPath(probe, state, actions, 2);
        actions[2] = _move(2, [LOWER_LANE, state.units[2].cell, 0, 0]);
        _rejectPath(probe, state, actions, 2);
        actions[2] =
            _move(GameTypes.SCOUT_MOVE_RANGE, [LOWER_LANE, state.units[1].cell, RANGER_STEP, 0]);
        _rejectPath(probe, state, actions, 2);
        actions[2] = _move(1, [LOWER_TURN, 0, 0, 0]);
        _rejectPath(probe, state, actions, 2);
        actions = _holds();
        state.units[0].cell = GameTypes.BOARD_SIZE - 1;
        actions[0] = _move(1, [GameTypes.BOARD_SIZE, 0, 0, 0]);
        _rejectPath(probe, state, actions, 0);
    }

    function _checkTargets(RulesProbe probe) private {
        GameTypes.BattleState memory state = GameTypes.initialBattleState();
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        actions[0] = _attack(GUARDIAN_STEP);
        actions[1] = _attack(RANGER_TARGET);
        actions[2] = _attack(LOWER_LANE);
        require(probe.validateActions(state, 0, actions) == 0, "Valid empty-cell attacks rejected");
        actions[0] = _attack(GUARDIAN_FAR);
        _rejectTarget(probe, state, actions, 0);
        actions = _holds();
        actions[1] = _attack(RANGER_FAR);
        _rejectTarget(probe, state, actions, 1);
        actions[1] = _attack(LOWER_TURN);
        _rejectTarget(probe, state, actions, 1);
        actions[1] = _attack(state.units[1].cell);
        _rejectTarget(probe, state, actions, 1);

        // A friendly unit on the ray does not block a shot at an empty cell.
        actions[1] = _attack(0);
        require(probe.validateActions(state, 0, actions) == 0, "Units blocked a Ranger ray");
        state.units[1].cell = UPPER_LANE;
        actions[1] = _attack(WALL_CELL + 2);
        _rejectTarget(probe, state, actions, 1);
        actions[1] = _attack(WALL_CELL);
        _rejectTarget(probe, state, actions, 1);
    }

    function _checkSkillsAndBudgets(RulesProbe probe) private {
        GameTypes.BattleState memory state = GameTypes.initialBattleState();
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        actions[0].kind = GameTypes.ActionKind.Shield;
        actions[1] = _attack(RANGER_TARGET);
        actions[1].kind = GameTypes.ActionKind.PowerShot;
        actions[2] = _move(GameTypes.MAX_PATH_LENGTH, [LOWER_LANE, LOWER_TURN, SCOUT_END, DASH_END]);
        actions[2].kind = GameTypes.ActionKind.Dash;
        uint8 totalCost = GameTypes.defaultRules().skillCost[0]
            + GameTypes.defaultRules().skillCost[1] + GameTypes.defaultRules().skillCost[2];
        state.players[0].energy = totalCost;
        require(
            probe.validateActions(state, 0, actions) == totalCost, "Combined skill costs differ"
        );
        state.players[0].energy = totalCost - 1;
        _reject(
            probe,
            state,
            0,
            actions,
            abi.encodeWithSelector(
                IArena.InsufficientEnergy.selector, uint8(0), totalCost, totalCost - 1
            )
        );
        actions = _holds();
        actions[1].kind = GameTypes.ActionKind.Shield;
        _reject(
            probe,
            state,
            0,
            actions,
            abi.encodeWithSelector(IArena.InvalidAction.selector, uint8(1))
        );
        actions = _holds();
        actions[0] = _attack(GUARDIAN_STEP);
        actions[0].kind = GameTypes.ActionKind.PowerShot;
        _reject(
            probe,
            state,
            0,
            actions,
            abi.encodeWithSelector(IArena.InvalidAction.selector, uint8(0))
        );
        actions[0] = _move(1, [GUARDIAN_STEP, 0, 0, 0]);
        actions[0].kind = GameTypes.ActionKind.Dash;
        _reject(
            probe,
            state,
            0,
            actions,
            abi.encodeWithSelector(IArena.InvalidAction.selector, uint8(0))
        );
        state.players[0].energy = 0;
        actions[0].kind = GameTypes.ActionKind.Move;
        require(probe.validateActions(state, 0, actions) == 0, "Free movement required Energy");
    }

    function _checkDeadSlots(RulesProbe probe) private {
        GameTypes.BattleState memory state = GameTypes.initialBattleState();
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        state.units[1].hp = 0;
        state.units[1].cell = GameTypes.NO_CELL;
        actions[2] = _move(2, [LOWER_LANE, GameTypes.defaultMap().spawnsA[1], 0, 0]);
        require(probe.validateActions(state, 0, actions) == 0, "Dead unit left an occupied cell");
        actions[1] = _attack(RANGER_TARGET);
        _reject(
            probe,
            state,
            0,
            actions,
            abi.encodeWithSelector(IArena.InvalidAction.selector, uint8(1))
        );
        actions = _holds();
        state.units[1].cell = GameTypes.defaultMap().spawnsA[1];
        _reject(
            probe,
            state,
            0,
            actions,
            abi.encodeWithSelector(IArena.InvalidUnitState.selector, uint8(1))
        );
    }

    function _checkEncoding(RulesProbe probe) private {
        GameTypes.BattleState memory state = GameTypes.initialBattleState();
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        actions[0].targetCell = 0;
        _rejectEncoding(probe, state, actions);
        actions = _holds();
        actions[0].path[0] = GUARDIAN_STEP;
        _rejectEncoding(probe, state, actions);
        actions = _holds();
        actions[0].kind = GameTypes.ActionKind.Move;
        _rejectEncoding(probe, state, actions);
        actions[0] = _move(GameTypes.MAX_PATH_LENGTH + 1, [GUARDIAN_STEP, 0, 0, 0]);
        _rejectEncoding(probe, state, actions);
        actions[0] = _attack(GameTypes.CELL_COUNT);
        _rejectEncoding(probe, state, actions);
    }

    function _holds() private pure returns (GameTypes.Action[SQUAD_SIZE] memory actions) {
        for (uint8 slot = 0; slot < GameTypes.SQUAD_SIZE; ++slot) {
            actions[slot].targetCell = GameTypes.NO_CELL;
        }
    }

    function _move(uint8 length, uint8[4] memory path)
        private
        pure
        returns (GameTypes.Action memory action)
    {
        action.kind = GameTypes.ActionKind.Move;
        action.targetCell = GameTypes.NO_CELL;
        action.pathLength = length;
        action.path = path;
    }

    function _attack(uint8 target) private pure returns (GameTypes.Action memory action) {
        action.kind = GameTypes.ActionKind.Attack;
        action.targetCell = target;
    }

    function _rejectPath(
        RulesProbe probe,
        GameTypes.BattleState memory state,
        GameTypes.Action[SQUAD_SIZE] memory actions,
        uint8 unitId
    ) private {
        _reject(
            probe, state, 0, actions, abi.encodeWithSelector(IArena.InvalidPath.selector, unitId)
        );
    }

    function _rejectTarget(
        RulesProbe probe,
        GameTypes.BattleState memory state,
        GameTypes.Action[SQUAD_SIZE] memory actions,
        uint8 unitId
    ) private {
        _reject(
            probe, state, 0, actions, abi.encodeWithSelector(IArena.InvalidTarget.selector, unitId)
        );
    }

    function _rejectEncoding(
        RulesProbe probe,
        GameTypes.BattleState memory state,
        GameTypes.Action[SQUAD_SIZE] memory actions
    ) private {
        _reject(
            probe,
            state,
            0,
            actions,
            abi.encodeWithSelector(IArena.InvalidActionEncoding.selector, uint8(0))
        );
    }

    function _reject(
        RulesProbe probe,
        GameTypes.BattleState memory state,
        uint8 playerIndex,
        GameTypes.Action[SQUAD_SIZE] memory actions,
        bytes memory expected
    ) private {
        _expectRevert(
            probe,
            abi.encodeCall(RulesProbe.validateActions, (state, playerIndex, actions)),
            expected
        );
    }

    function _expectRevert(RulesProbe probe, bytes memory payload, bytes memory expected) private {
        // The raw call checks the complete custom error, including its arguments.
        // forge-lint: disable-next-line(low-level-calls)
        (bool success, bytes memory actual) = address(probe).call(payload);
        require(!success, "Expected a static-rule revert");
        require(actual.length == expected.length, "Unexpected static-rule error length");
        uint256 index = 0;
        for (; index < expected.length; ++index) {
            if (actual[index] != expected[index]) break;
        }
        require(index == expected.length, "Unexpected static-rule error data");
    }
}
