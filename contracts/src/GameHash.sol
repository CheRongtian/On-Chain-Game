// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "./GameTypes.sol";
import { IArena } from "./IArena.sol";

library GameHash {
    bytes32 internal constant RULES_DOMAIN = keccak256("OnChainTacticalArena.Rules");
    bytes32 internal constant ACTIONS_DOMAIN = keccak256("OnChainTacticalArena.Actions");
    bytes32 internal constant STATE_DOMAIN = keccak256("OnChainTacticalArena.BattleState");
    bytes32 internal constant COMMITMENT_TYPEHASH = keccak256(
        "ActionCommitment((uint256,address,uint256),uint8,address,bytes32,bytes32,bytes32)"
    );

    // Every payload uses standard abi.encode, with 32-byte words; no packed encoding.
    function rulesHash() internal pure returns (bytes32) {
        return keccak256(
            abi.encode(RULES_DOMAIN, GameTypes.defaultRules(), GameTypes.defaultMap())
        );
    }

    function hashActions(GameTypes.Action[3] memory actions) internal pure returns (bytes32) {
        validateActionEncoding(actions);
        return keccak256(abi.encode(ACTIONS_DOMAIN, actions));
    }

    function validateActionEncoding(GameTypes.Action[3] memory actions) internal pure {
        uint8 slot = 0;
        for (; slot < GameTypes.SQUAD_SIZE; ++slot) {
            if (!_isCanonicalAction(actions[slot])) break;
        }
        if (slot < GameTypes.SQUAD_SIZE) revert IArena.InvalidActionEncoding(slot);
    }

    // Clients compute this locally before broadcasting; salt is a fresh random 32-byte value.
    function actionCommitment(
        GameTypes.MatchContext memory context,
        uint8 round,
        address player,
        GameTypes.Action[3] memory actions,
        bytes32 salt
    ) internal pure returns (bytes32) {
        _validateRound(round);
        return keccak256(
            abi.encode(
                COMMITMENT_TYPEHASH,
                context,
                round,
                player,
                rulesHash(),
                hashActions(actions),
                salt
            )
        );
    }

    // Phase, deadlines, commitments, reveal flags, and salts stay outside the battle hash.
    // Timeout changes only outcome/reason; cancellation/expiry before joining has no battle hash.
    function hashBattleState(
        GameTypes.MatchContext memory context, GameTypes.BattleState memory state
    ) internal pure returns (bytes32) {
        validateBattleState(state);
        return keccak256(abi.encode(STATE_DOMAIN, context, rulesHash(), state));
    }

    function _isCanonicalAction(GameTypes.Action memory action) private pure returns (bool) {
        bool moves = action.kind == GameTypes.ActionKind.Move
            || action.kind == GameTypes.ActionKind.Dash;
        bool attacks = action.kind == GameTypes.ActionKind.Attack
            || action.kind == GameTypes.ActionKind.PowerShot;

        if (moves) {
            if (
                action.targetCell != GameTypes.NO_CELL || action.pathLength == 0
                    || action.pathLength > GameTypes.MAX_PATH_LENGTH
            ) return false;
        } else {
            if (action.pathLength != 0) return false;
            if (attacks) {
                if (action.targetCell >= GameTypes.CELL_COUNT) {
                    return false;
                }
            } else if (action.targetCell != GameTypes.NO_CELL) {
                return false;
            }
        }

        for (uint8 step = 0; step < GameTypes.MAX_PATH_LENGTH; ++step) {
            if (step < action.pathLength) {
                if (action.path[step] >= GameTypes.CELL_COUNT) {
                    return false;
                }
            } else if (action.path[step] != 0) {
                return false;
            }
        }
        return true;
    }

    // Game rules validate paths, costs, and battle outcomes before hashing.
    function validateBattleState(GameTypes.BattleState memory state) internal pure {
        if (state.mapId != GameTypes.MAP_ID) revert IArena.UnknownMap(state.mapId);
        _validateRound(state.round);
        GameTypes.Rules memory rules = GameTypes.defaultRules();

        uint8 player = 0;
        for (; player < 2; ++player) {
            if (state.players[player].energy > rules.maxEnergy) break;
        }
        if (player < 2) revert IArena.InvalidPlayerState(player);

        uint8 slot = 0;
        for (; slot < GameTypes.UNIT_COUNT; ++slot) {
            uint8 localSlot = slot % GameTypes.SQUAD_SIZE;
            GameTypes.UnitState memory unit = state.units[slot];
            if (
                unit.unitType != GameTypes.UnitKind(localSlot + 1)
                    || unit.hp > rules.maxHp[localSlot]
                    || (unit.hp == 0 && unit.cell != GameTypes.NO_CELL)
                    || (unit.hp != 0 && unit.cell >= GameTypes.CELL_COUNT)
            ) break;
        }
        if (slot < GameTypes.UNIT_COUNT) revert IArena.InvalidUnitState(slot);

        bool ongoing = state.outcome == GameTypes.Outcome.None;
        if (ongoing != (state.reason == GameTypes.EndReason.None)) {
            revert IArena.InvalidBattleResult();
        }
    }

    function _validateRound(uint8 round) private pure {
        if (round == 0 || round > GameTypes.MAX_ROUNDS) revert IArena.InvalidRound(round);
    }
}
