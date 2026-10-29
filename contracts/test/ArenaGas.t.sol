// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { Arena } from "../src/Arena.sol";
import { GameTypes } from "../src/GameTypes.sol";
import { GameHash } from "../src/GameHash.sol";
import { SafetySupport, SafetyActions } from "./SafetySupport.sol";

// The read probe is colocated with the gas fixture that measures it.
// forge-lint: disable-next-line(multi-contract-file)
contract ReadAccessProbe {
    function readTwice(Arena arena, uint256 id) external view returns (uint256 cold, uint256 warm) {
        uint256 beforeGas = gasleft();
        GameTypes.BattleState memory first = arena.getBattleState(id);
        cold = beforeGas - gasleft();
        beforeGas = gasleft();
        GameTypes.BattleState memory second = arena.getBattleState(id);
        warm = beforeGas - gasleft();
        require(first.round == second.round, "Read changed state");
    }
}

// Explicit coordinates and boundary values describe the measured board fixtures.
// forge-lint: disable-next-item(multi-contract-file, literal-instead-of-constant)
contract ArenaGasTest is SafetySupport {
    uint256 private id;
    uint256 private constant LOCAL_BLOCK_GAS_LIMIT = 30_000_000;

    function setUp() public {
        arena = new Arena();
        id = room();
    }

    function testGasCommitFirst() public {
        VM.pauseGasMetering();
        bytes32 value =
            GameHash.actionCommitment(context(id), 1, HOST, SafetyActions.holds(), SALT_A);
        _measure(
            "commit-first",
            HOST,
            abi.encodeCall(Arena.commitActions, (id, uint8(1), value)),
            100_000
        );
    }

    function testGasCommitSecond() public {
        VM.pauseGasMetering();
        commit(id, HOST, SafetyActions.holds(), SALT_A);
        bytes32 value =
            GameHash.actionCommitment(context(id), 1, GUEST, SafetyActions.holds(), SALT_B);
        _measure(
            "commit-second",
            GUEST,
            abi.encodeCall(Arena.commitActions, (id, uint8(1), value)),
            100_000
        );
    }

    function testGasRevealFirstLongestBundle() public {
        VM.pauseGasMetering();
        _dense();
        (GameTypes.Action[3] memory a, GameTypes.Action[3] memory b) = _skills();
        commit(id, HOST, a, SALT_A);
        commit(id, GUEST, b, SALT_B);
        _measure(
            "reveal-first",
            HOST,
            abi.encodeCall(Arena.revealActions, (id, arena.getMatch(id).round, a, SALT_A)),
            250_000
        );
    }

    function testGasRevealSecondLongestBundle() public {
        VM.pauseGasMetering();
        _dense();
        (GameTypes.Action[3] memory a, GameTypes.Action[3] memory b) = _skills();
        commit(id, HOST, a, SALT_A);
        commit(id, GUEST, b, SALT_B);
        reveal(id, HOST, a, SALT_A);
        _measure(
            "reveal-second",
            GUEST,
            abi.encodeCall(Arena.revealActions, (id, arena.getMatch(id).round, b, SALT_B)),
            250_000
        );
    }

    function testGasSettleAllSkills() public {
        VM.pauseGasMetering();
        _dense();
        (GameTypes.Action[3] memory a, GameTypes.Action[3] memory b) = _skills();
        _prepare(a, b);
        _settle("settle-all-skills");
    }

    function testGasSettleSixAttacksAndDeaths() public {
        VM.pauseGasMetering();
        _dense();
        GameTypes.Action[3] memory a = SafetyActions.holds();
        GameTypes.Action[3] memory b = SafetyActions.holds();
        a[0] = _attack(GameTypes.ActionKind.Attack, 28);
        a[1] = _attack(GameTypes.ActionKind.PowerShot, 28);
        a[2] = _attack(GameTypes.ActionKind.Attack, 44);
        b[0] = _attack(GameTypes.ActionKind.Attack, 36);
        b[1] = _attack(GameTypes.ActionKind.PowerShot, 36);
        b[2] = _attack(GameTypes.ActionKind.Attack, 36);
        _prepare(a, b);
        _settle("settle-six-attacks");
        require(
            arena.getBattleState(id).units[2].hp == 0 && arena.getBattleState(id).units[5].hp == 0,
            "Fixture did not defeat both Scouts"
        );
    }

    function testGasSettleSharedDestinations() public {
        VM.pauseGasMetering();
        _dense();
        GameTypes.Action[3] memory a = SafetyActions.holds();
        GameTypes.Action[3] memory b = SafetyActions.holds();
        a[0] = _move(19, 0, 0, 0, 1);
        a[1] = _attack(GameTypes.ActionKind.PowerShot, 28);
        a[2] = _move(35, 43, 0, 0, 2);
        b[0] = _move(43, 0, 0, 0, 1);
        b[1] = _attack(GameTypes.ActionKind.PowerShot, 36);
        b[2] = _move(27, 19, 0, 0, 2);
        _prepare(a, b);
        _settle("settle-shared-destinations");
        GameTypes.BattleState memory state = arena.getBattleState(id);
        require(
            state.units[0].cell == 20 && state.units[2].cell == 36 && state.units[3].cell == 44
                && state.units[5].cell == 28,
            "Collision fixture did not collide"
        );
    }

    // Advancing to the last legal round requires repeated calls to the local Arena.
    // forge-lint: disable-next-item(calls-loop)
    function testGasSettleMaximumRound() public {
        VM.pauseGasMetering();
        _dense();
        while (arena.getMatch(id).round < GameTypes.MAX_ROUNDS) {
            _play(SafetyActions.holds(), SafetyActions.holds());
        }
        _prepare(SafetyActions.holds(), SafetyActions.holds());
        _settle("settle-maximum-round");
        require(
            arena.getMatch(id).reason == GameTypes.EndReason.RoundLimit, "Round limit not reached"
        );
    }

    // The fixture reaches the real scoring boundary through bounded local rounds.
    // forge-lint: disable-next-item(calls-loop)
    function testGasSettleVictoryThreshold() public {
        VM.pauseGasMetering();
        _dense();
        GameTypes.Action[3] memory b = SafetyActions.holds();
        b[2] = _move(29, 0, 0, 0, 1);
        _play(SafetyActions.holds(), b);
        while (arena.getBattleState(id).players[0].victoryPoints < 10) {
            _play(SafetyActions.holds(), SafetyActions.holds());
        }
        _prepare(SafetyActions.holds(), SafetyActions.holds());
        _settle("settle-victory-threshold");
        require(
            arena.getMatch(id).reason == GameTypes.EndReason.VictoryPoints,
            "Victory threshold not reached"
        );
    }

    function testGasCommitTimeout() public {
        VM.pauseGasMetering();
        commit(id, HOST, SafetyActions.holds(), SALT_A);
        VM.warp(uint256(arena.getMatch(id).phaseDeadline) + 1);
        _measure(
            "commit-timeout",
            OBSERVER,
            abi.encodeCall(Arena.advanceExpiredPhase, (id, uint8(1), GameTypes.Phase.Commit)),
            0
        );
    }

    function testGasRevealTimeout() public {
        VM.pauseGasMetering();
        commit(id, HOST, SafetyActions.holds(), SALT_A);
        commit(id, GUEST, SafetyActions.holds(), SALT_B);
        reveal(id, HOST, SafetyActions.holds(), SALT_A);
        VM.warp(uint256(arena.getMatch(id).phaseDeadline) + 1);
        _measure(
            "reveal-timeout",
            OBSERVER,
            abi.encodeCall(Arena.advanceExpiredPhase, (id, uint8(1), GameTypes.Phase.Reveal)),
            0
        );
    }

    function testGasRepeatedStateReads() public {
        ReadAccessProbe probe = new ReadAccessProbe();
        (uint256 cold, uint256 warm) = probe.readTwice(arena, id);
        require(warm < cold, "Repeated access did not warm storage");
        // Only a fixed local evidence path is writable under foundry.toml.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        VM.writeFile(
            "../.local/safety/gas-reads.json",
            string.concat(
                '{"coldExecutionGas":',
                VM.toString(cold),
                ',"warmExecutionGas":',
                VM.toString(warm),
                "}"
            )
        );
    }

    function _measure(string memory name, address caller, bytes memory payload, uint256 budget)
        private
    {
        VM.prank(caller);
        VM.resumeGasMetering();
        uint256 beforeGas = gasleft();
        // A checked raw call measures the selected local Arena operation without extra dispatch.
        // forge-lint: disable-next-line(low-level-calls)
        (bool ok,) = address(arena).call(payload);
        uint256 used = beforeGas - gasleft();
        VM.pauseGasMetering();
        require(ok, "Measured transaction reverted");
        // Keep the measured call delta separate from an added intrinsic calldata allowance.
        uint256 total = used + 21_000;
        for (uint256 index = 0; index < payload.length; ++index) {
            total += payload[index] == 0 ? 4 : 16;
        }
        require(total < LOCAL_BLOCK_GAS_LIMIT, "Sample exceeds the local block gas limit");
        string memory row =
            string.concat('{"name":"', name, '","measuredCallGas":', VM.toString(used));
        row = string.concat(
            row,
            ',"withIntrinsicUpperBound":',
            VM.toString(total),
            ',"initialBudget":',
            VM.toString(budget)
        );
        // Names are fixed by these tests and the output stays in the permitted evidence directory.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        VM.writeFile(
            string.concat("../.local/safety/gas-", name, ".json"),
            string.concat(row, ',"localBlockGasLimit":', VM.toString(LOCAL_BLOCK_GAS_LIMIT), "}")
        );
    }

    function _settle(string memory name) private {
        _measure(
            name,
            OBSERVER,
            abi.encodeCall(Arena.settleRound, (id, arena.getMatch(id).round)),
            1_500_000
        );
    }

    function _prepare(GameTypes.Action[3] memory a, GameTypes.Action[3] memory b) private {
        commit(id, HOST, a, SALT_A);
        commit(id, GUEST, b, SALT_B);
        reveal(id, HOST, a, SALT_A);
        reveal(id, GUEST, b, SALT_B);
    }

    // Dense-board preparation deliberately resolves bounded rounds through the fixed Arena.
    // forge-lint: disable-next-item(calls-loop)
    function _play(GameTypes.Action[3] memory a, GameTypes.Action[3] memory b) private {
        _prepare(a, b);
        arena.settleRound(id, arena.getMatch(id).round);
    }

    // Every dense fixture is reached through public calls from the actual initial state.
    function _dense() private {
        for (uint256 round = 0; round < 8; ++round) {
            GameTypes.Action[3] memory a = SafetyActions.holds();
            GameTypes.Action[3] memory b = SafetyActions.holds();
            if (round == 0) {
                a[0] = _move(9, 0, 0, 0, 1);
                a[1] = _move(25, 26, 0, 0, 2);
                a[2] = _move(32, 33, 34, 0, 3);
                b[0] = _move(54, 0, 0, 0, 1);
                b[1] = _move(38, 37, 0, 0, 2);
                b[2] = _move(31, 30, 29, 0, 3);
            } else if (round == 1) {
                a[0] = _move(10, 0, 0, 0, 1);
                b[0] = _move(53, 0, 0, 0, 1);
            } else if (round == 2) {
                a[0] = _move(11, 0, 0, 0, 1);
                b[0] = _move(52, 0, 0, 0, 1);
            } else if (round == 3) {
                a[0] = _move(19, 0, 0, 0, 1);
                a[2] = _move(35, 36, 0, 0, 2);
                b[0] = _move(44, 0, 0, 0, 1);
                b[2] = _move(28, 0, 0, 0, 1);
            } else if (round == 4) {
                a[0] = _move(18, 0, 0, 0, 1);
                b[0] = _move(45, 0, 0, 0, 1);
            } else if (round == 6) {
                a[0] = _move(19, 0, 0, 0, 1);
                b[0] = _move(44, 0, 0, 0, 1);
            } else if (round == 7) {
                a[0] = _move(20, 0, 0, 0, 1);
            }
            _play(a, b);
        }
        GameTypes.BattleState memory state = arena.getBattleState(id);
        require(
            state.round == 9 && state.players[0].energy == 4 && state.players[1].energy == 4,
            "Dense fixture differs"
        );
    }

    function _skills()
        private
        pure
        returns (GameTypes.Action[3] memory a, GameTypes.Action[3] memory b)
    {
        a = SafetyActions.holds();
        b = SafetyActions.holds();
        a[0].kind = GameTypes.ActionKind.Shield;
        b[0].kind = GameTypes.ActionKind.Shield;
        a[1] = _attack(GameTypes.ActionKind.PowerShot, 28);
        b[1] = _attack(GameTypes.ActionKind.PowerShot, 36);
        a[2] = _move(35, 43, 51, 50, 4);
        b[2] = _move(27, 19, 11, 3, 4);
        a[2].kind = GameTypes.ActionKind.Dash;
        b[2].kind = GameTypes.ActionKind.Dash;
    }

    function _move(uint8 a, uint8 b, uint8 c, uint8 d, uint8 length)
        private
        pure
        returns (GameTypes.Action memory action)
    {
        action.kind = GameTypes.ActionKind.Move;
        action.targetCell = GameTypes.NO_CELL;
        action.pathLength = length;
        action.path = [a, b, c, d];
    }

    function _attack(GameTypes.ActionKind kind, uint8 target)
        private
        pure
        returns (GameTypes.Action memory action)
    {
        action.kind = kind;
        action.targetCell = target;
    }
}
