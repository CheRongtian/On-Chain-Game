// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "../src/SquadCodec.sol";
import { SquadRules } from "../src/SquadRules.sol";
import { SquadBattleProbe } from "../script/CheckSquadBattle.s.sol";
import { SquadSafetySupport as Support } from "./SquadSafetySupport.sol";
import { SquadRuleSafetyTest } from "./SquadRuleSafety.t.sol";
import { ISafetyVm } from "./SafetySupport.sol";

// Bounded fixture reads/calls and explicit board coordinates describe these measured samples.
// forge-lint: disable-start(literal-instead-of-constant,require-revert-in-loop,calls-loop)
contract SquadRuleGasTest {
    ISafetyVm private constant VM = ISafetyVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    uint256 private constant INITIAL_SETTLEMENT_TARGET = 2_000_000;
    SquadBattleProbe private probe;

    function setUp() public {
        probe = new SquadBattleProbe();
    }

    function testGasSixMovesArena() public {
        _moves(1, "six-moves-Arena");
    }

    function testGasSixMovesRuins() public {
        _moves(2, "six-moves-Ruins");
    }

    function testGasSixMovesCrossroads() public {
        _moves(3, "six-moves-Crossroads");
    }

    function testGasCoverShieldArena() public {
        _reference("cover-shield-map-1");
    }

    function testGasCoverShieldRuins() public {
        _reference("cover-shield-map-2");
    }

    function testGasCoverShieldCrossroads() public {
        _reference("cover-shield-map-3");
    }

    function testGasFullDash() public {
        _reference("Scout-four-step-Dash");
    }

    function testGasRoundTwentyHash() public {
        _reference("round-cap-new-lock-21");
    }

    function testGasResourcesControl() public {
        _reference("resource-cap-central-victory");
    }

    function testGasDyingLockCaster() public {
        _reference("dying-lock-caster");
    }

    function testGasHealingBeforeLethal() public {
        _reference("healing-before-lethal-damage");
    }

    function testGasSixSkills() public {
        VM.pauseGasMetering();
        SquadBattleProbe.Output memory output =
            _measure("six-skills", Support.preludeState(), Support.preludeOrders(false));
        require(
            output.effects.energySpent[0] == 4 && output.effects.energySpent[1] == 5,
            "Six-skill fixture missed budget"
        );
        require(
            output.effects.healed[0] == 2 && output.effects.shieldReduced[0] == 2
                && output.effects.lockedRoundApplied[0] == 20,
            "Six-skill fixture missed effects"
        );
    }

    function testGasSixAttacksAndDeaths() public {
        VM.pauseGasMetering();
        SquadCodec.State memory state = SquadRules.initialize(1, [uint8(1), 2, 3], [uint8(1), 2, 3]);
        state.completedRound = 3;
        uint8[6] memory cells = [uint8(0), 8, 4, 1, 9, 5];
        SquadCodec.Action[3][2] memory actions = Support.holds();
        for (uint256 id = 0; id < 6; ++id) {
            state.units[id].hp = 1;
            state.units[id].position = cells[id];
            actions[id / 3][id % 3].actionType = 2;
            actions[id / 3][id % 3].targetCell = cells[(id + 3) % 6];
        }
        SquadBattleProbe.Output memory output = _measure("six-attacks-and-deaths", state, actions);
        require(
            output.next.outcome == 3 && output.next.reason == 2,
            "Six attacks missed mutual elimination"
        );
        for (uint256 id = 0; id < 6; ++id) {
            require(!output.next.units[id].alive, "Attack fixture retained survivor");
        }
    }

    function _moves(uint8 mapId, string memory name) private {
        VM.pauseGasMetering();
        SquadCodec.State memory state =
            SquadRules.initialize(mapId, [uint8(1), 2, 3], [uint8(1), 2, 3]);
        SquadBattleProbe.Output memory output = _measure(name, state, Support.allMoves(state));
        for (uint256 id = 0; id < 6; ++id) {
            require(output.effects.moved[id], "Six-move fixture did not move everyone");
        }
    }

    function _reference(string memory name) private {
        VM.pauseGasMetering();
        // The dispatcher prepares the same unchanged golden corpus used by rule unit tests.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        SquadRuleSafetyTest.Vector[] memory vectors = abi.decode(
            VM.readFileBinary("../.local/simulation/squad-safety/references.abi"),
            (SquadRuleSafetyTest.Vector[])
        );
        for (uint256 index = 0; index < vectors.length; ++index) {
            if (_sameName(vectors[index].name, name)) {
                SquadBattleProbe.Output memory output =
                    _measure(name, vectors[index].initial, vectors[index].actions);
                require(
                    output.stateHash == vectors[index].stateHash,
                    "Gas fixture changed expected result"
                );
                return;
            }
        }
        revert("Missing named Gas fixture");
    }

    function _measure(
        string memory name,
        SquadCodec.State memory state,
        SquadCodec.Action[3][2] memory actions
    ) private returns (SquadBattleProbe.Output memory output) {
        bytes memory payload = abi.encode(
            SquadBattleProbe.Input({ context: Support.context(), state: state, actions: actions })
        );
        VM.resumeGasMetering();
        uint256 beforeGas = gasleft();
        bytes memory result = probe.evaluate(0, payload);
        uint256 fixtureCallGas = beforeGas - gasleft();
        VM.pauseGasMetering();
        output = abi.decode(result, (SquadBattleProbe.Output));
        Support.checkTransition(state, actions, output);
        // The dispatcher reports every budget miss after all pressure samples have been written.
        string memory row = string.concat(
            '{"name":"',
            name,
            '","fixtureCallGas":',
            VM.toString(fixtureCallGas),
            ',"resolveGas":',
            VM.toString(output.resolveGas)
        );
        row = string.concat(
            row,
            ',"hashGas":',
            VM.toString(output.hashGas),
            ',"initialSettlementTarget":',
            VM.toString(INITIAL_SETTLEMENT_TARGET),
            "}"
        );
        // This evidence is confined to the existing safety directory.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        VM.writeFile(string.concat("../.local/safety/squad-gas-", name, ".json"), row);
    }

    function _sameName(string memory a, string memory b) private pure returns (bool) {
        bytes memory first = bytes(a);
        bytes memory second = bytes(b);
        if (first.length != second.length) return false;
        for (uint256 index = 0; index < first.length; ++index) {
            if (first[index] != second[index]) return false;
        }
        return true;
    }
}
// forge-lint: disable-end(literal-instead-of-constant,require-revert-in-loop,calls-loop)
