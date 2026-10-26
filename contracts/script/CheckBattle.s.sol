// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "../src/GameTypes.sol";
import { GameHash } from "../src/GameHash.sol";
import { BattleResolver } from "../src/BattleResolver.sol";
import { IArena } from "../src/IArena.sol";
import { BattleProbe } from "./BattleProbe.sol";
import { IDevVm } from "./IDevVm.sol";

contract CheckBattle {
    IDevVm private constant VM = IDevVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    uint256 private constant SQUAD_SIZE = 3;
    uint8 private constant RESOURCE_CELL = 18;
    uint8 private constant INVALID_ENEMY_STEP = 53;

    string private constant VECTOR_SCHEMA =
        "BattleVectors(bytes32 rulesHash,BattleVector[] cases)"
        "Action(uint8 kind,uint8 targetCell,uint8 pathLength,uint8[4] path)"
        "BattleState(uint8 mapId,uint8 round,PlayerState[2] players,"
        "UnitState[6] units,uint8 outcome,uint8 reason)"
        "BattleVector(string name,MatchContext context,BattleState state,"
        "Action[3] actionsA,Action[3] actionsB,BattleState expectedState,"
        "ResolutionSummary expectedSummary,bytes32 expectedHash)"
        "MatchContext(uint256 chainId,address arena,uint256 matchId)"
        "PlayerState(uint8 energy,uint8 victoryPoints)"
        "ResolutionSummary(uint8[2] energySpent,bool[6] moved,uint8[6] damageTaken,"
        "uint8[2] energyGained,uint8[2] victoryPointsGained)"
        "UnitState(uint8 unitType,uint8 cell,uint8 hp)";

    struct BattleVector {
        string name;
        GameTypes.MatchContext context;
        GameTypes.BattleState state;
        GameTypes.Action[SQUAD_SIZE] actionsA;
        GameTypes.Action[SQUAD_SIZE] actionsB;
        GameTypes.BattleState expectedState;
        GameTypes.ResolutionSummary expectedSummary;
        bytes32 expectedHash;
    }

    struct BattleVectors {
        bytes32 rulesHash;
        BattleVector[] cases;
    }

    function run() external returns (uint256 battleCases) {
        // The committed fixture file has an explicit read-only permission in foundry.toml.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = VM.readFile("../config/battle-vectors.json");
        BattleVectors memory vectors =
            abi.decode(VM.parseJsonType(json, VECTOR_SCHEMA), (BattleVectors));
        require(vectors.rulesHash == GameHash.rulesHash(), "Battle rules hash differs");
        battleCases = vectors.cases.length;
        require(battleCases != 0, "Battle vectors are empty");
        uint256 index = 0;
        string memory failure = "";
        for (; index < battleCases; ++index) {
            failure = _checkCase(vectors.cases[index]);
            if (bytes(failure).length != 0) break;
        }
        if (index < battleCases) {
            revert(string.concat("Battle vector ", vectors.cases[index].name, ": ", failure));
        }
        BattleProbe probe = new BattleProbe();
        _rejectFinishedState(probe);
        _rejectInvalidOpponent(probe);
        _rejectIncomeFunding(probe);
    }

    function _checkCase(BattleVector memory vector) private pure returns (string memory) {
        bytes memory original = abi.encode(vector.state, vector.actionsA, vector.actionsB);
        (GameTypes.BattleState memory next, GameTypes.ResolutionSummary memory summary) =
            BattleResolver.resolve(vector.state, vector.actionsA, vector.actionsB);
        if (!_sameBytes(original, abi.encode(vector.state, vector.actionsA, vector.actionsB))) {
            return "input snapshot changed";
        }
        if (!_sameBytes(abi.encode(next), abi.encode(vector.expectedState))) return "state differs";
        if (!_sameBytes(abi.encode(summary), abi.encode(vector.expectedSummary))) {
            return "summary differs";
        }
        if (!_uniqueSurvivors(next.units)) return "survivors overlap";
        if (GameHash.hashBattleState(vector.context, next) != vector.expectedHash) {
            return "state hash differs";
        }

        // Swap ownership and slot groups without rotating the board or changing the rules.
        (next, summary) = BattleResolver.resolve(
            _swapState(vector.state), vector.actionsB, vector.actionsA
        );
        if (!_sameBytes(abi.encode(next), abi.encode(_swapState(vector.expectedState)))) {
            return "player order changed the state";
        }
        if (!_sameBytes(abi.encode(summary), abi.encode(_swapSummary(vector.expectedSummary)))) {
            return "player order changed the summary";
        }
        return "";
    }

    function _swapState(GameTypes.BattleState memory state)
        private
        pure
        returns (GameTypes.BattleState memory swapped)
    {
        swapped = abi.decode(abi.encode(state), (GameTypes.BattleState));
        GameTypes.PlayerState memory firstPlayer = GameTypes.PlayerState({
            energy: swapped.players[0].energy,
            victoryPoints: swapped.players[0].victoryPoints
        });
        swapped.players[0] = swapped.players[1];
        swapped.players[1] = firstPlayer;
        for (uint256 slot = 0; slot < GameTypes.SQUAD_SIZE; ++slot) {
            GameTypes.UnitState memory firstUnit = GameTypes.UnitState({
                unitType: swapped.units[slot].unitType,
                cell: swapped.units[slot].cell,
                hp: swapped.units[slot].hp
            });
            swapped.units[slot] = swapped.units[slot + GameTypes.SQUAD_SIZE];
            swapped.units[slot + GameTypes.SQUAD_SIZE] = firstUnit;
        }
        if (state.outcome == GameTypes.Outcome.PlayerA) swapped.outcome = GameTypes.Outcome.PlayerB;
        else if (state.outcome == GameTypes.Outcome.PlayerB) swapped.outcome = GameTypes.Outcome.PlayerA;
    }

    function _swapSummary(GameTypes.ResolutionSummary memory summary)
        private
        pure
        returns (GameTypes.ResolutionSummary memory swapped)
    {
        swapped.energySpent[0] = summary.energySpent[1];
        swapped.energySpent[1] = summary.energySpent[0];
        swapped.energyGained[0] = summary.energyGained[1];
        swapped.energyGained[1] = summary.energyGained[0];
        swapped.victoryPointsGained[0] = summary.victoryPointsGained[1];
        swapped.victoryPointsGained[1] = summary.victoryPointsGained[0];
        for (uint256 slot = 0; slot < GameTypes.SQUAD_SIZE; ++slot) {
            swapped.moved[slot] = summary.moved[slot + GameTypes.SQUAD_SIZE];
            swapped.moved[slot + GameTypes.SQUAD_SIZE] = summary.moved[slot];
            swapped.damageTaken[slot] = summary.damageTaken[slot + GameTypes.SQUAD_SIZE];
            swapped.damageTaken[slot + GameTypes.SQUAD_SIZE] = summary.damageTaken[slot];
        }
    }

    function _uniqueSurvivors(GameTypes.UnitState[6] memory units) private pure returns (bool) {
        for (uint256 slot = 0; slot < GameTypes.UNIT_COUNT; ++slot) {
            if (units[slot].hp == 0) continue;
            for (uint256 other = slot + 1; other < GameTypes.UNIT_COUNT; ++other) {
                if (units[other].hp != 0 && units[slot].cell == units[other].cell) return false;
            }
        }
        return true;
    }

    function _rejectFinishedState(BattleProbe probe) private {
        GameTypes.BattleState memory state = GameTypes.initialBattleState();
        state.round = GameTypes.MAX_ROUNDS;
        state.outcome = GameTypes.Outcome.Draw;
        state.reason = GameTypes.EndReason.RoundLimit;
        _expectRevert(
            probe, abi.encodeCall(BattleProbe.resolve, (state, _holds(), _holds())),
            abi.encodeWithSelector(IArena.InvalidBattleResult.selector)
        );
    }

    function _rejectInvalidOpponent(BattleProbe probe) private {
        GameTypes.BattleState memory state = GameTypes.initialBattleState();
        GameTypes.Action[SQUAD_SIZE] memory actionsA = _holds();
        GameTypes.Action[SQUAD_SIZE] memory actionsB = _holds();
        actionsA[0].kind = GameTypes.ActionKind.Shield;
        actionsB[0].kind = GameTypes.ActionKind.Move;
        actionsB[0].pathLength = 1;
        actionsB[0].path[0] = INVALID_ENEMY_STEP;
        _expectRevert(
            probe, abi.encodeCall(BattleProbe.resolve, (state, actionsA, actionsB)),
            abi.encodeWithSelector(IArena.InvalidPath.selector, GameTypes.SQUAD_SIZE)
        );
    }

    function _rejectIncomeFunding(BattleProbe probe) private {
        GameTypes.BattleState memory state = GameTypes.initialBattleState();
        state.units[0].cell = RESOURCE_CELL;
        state.players[0].energy = 0;
        GameTypes.Action[SQUAD_SIZE] memory actions = _holds();
        actions[0].kind = GameTypes.ActionKind.Shield;
        _expectRevert(
            probe, abi.encodeCall(BattleProbe.resolve, (state, actions, _holds())),
            abi.encodeWithSelector(
                IArena.InsufficientEnergy.selector, uint8(0), uint8(1), uint8(0)
            )
        );
    }

    function _holds() private pure returns (GameTypes.Action[SQUAD_SIZE] memory actions) {
        for (uint256 slot = 0; slot < GameTypes.SQUAD_SIZE; ++slot) {
            actions[slot].targetCell = GameTypes.NO_CELL;
        }
    }

    function _expectRevert(BattleProbe probe, bytes memory payload, bytes memory expected) private {
        // The ordinary probe call exposes the complete custom error without script self-calls.
        // forge-lint: disable-next-line(low-level-calls)
        (bool success, bytes memory actual) = address(probe).call(payload);
        require(!success, "Expected a resolver revert");
        require(_sameBytes(actual, expected), "Unexpected resolver error");
    }

    function _sameBytes(bytes memory actual, bytes memory expected) private pure returns (bool) {
        if (actual.length != expected.length) return false;
        for (uint256 index = 0; index < expected.length; ++index) {
            if (actual[index] != expected[index]) return false;
        }
        return true;
    }
}
