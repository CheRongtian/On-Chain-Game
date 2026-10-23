// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { GameTypes } from "../src/GameTypes.sol";
import { GameHash } from "../src/GameHash.sol";
import { IArena } from "../src/IArena.sol";
import { ActionEncodingProbe } from "./ActionEncodingProbe.sol";

// Invoked locally by the backend launcher without broadcasting transactions.
contract CheckProtocol {
    uint256 private constant BASE_CHAIN_ID = 31_337;
    address private constant BASE_ARENA = address(0xA11CE);
    address private constant OTHER_ADDRESS = address(0xCAFE);

    function run(bytes32 expectedActionsHash)
        external
        returns (bytes32 actionsHash, bytes32 initialStateHash)
    {
        GameTypes.Action[3] memory actions;
        for (uint8 slot = 0; slot < GameTypes.SQUAD_SIZE; ++slot) {
            actions[slot].targetCell = GameTypes.NO_CELL;
        }
        actionsHash = GameHash.hashActions(actions);
        require(actionsHash == expectedActionsHash, "Action encoding differs from Cast");

        GameTypes.MatchContext memory context = GameTypes.MatchContext({
            chainId: BASE_CHAIN_ID, arena: BASE_ARENA, matchId: 1
        });
        address player = address(0xB0B);
        bytes32 salt = bytes32(uint256(1));
        bytes32 commitment = GameHash.actionCommitment(context, 1, player, actions, salt);

        context.chainId = 31_338;
        require(
            commitment != GameHash.actionCommitment(context, 1, player, actions, salt),
            "Commitment does not bind chain"
        );
        context.chainId = BASE_CHAIN_ID;

        context.arena = OTHER_ADDRESS;
        require(
            commitment != GameHash.actionCommitment(context, 1, player, actions, salt),
            "Commitment does not bind arena"
        );
        context.arena = BASE_ARENA;

        context.matchId = 2;
        require(
            commitment != GameHash.actionCommitment(context, 1, player, actions, salt),
            "Commitment does not bind match"
        );
        context.matchId = 1;

        require(
            commitment != GameHash.actionCommitment(context, 2, player, actions, salt),
            "Commitment does not bind round"
        );
        require(
            commitment != GameHash.actionCommitment(context, 1, OTHER_ADDRESS, actions, salt),
            "Commitment does not bind player"
        );
        require(
            commitment != GameHash.actionCommitment(context, 1, player, actions, bytes32(uint256(2))),
            "Commitment does not bind salt"
        );

        initialStateHash = GameHash.hashBattleState(context, GameTypes.initialBattleState());

        actions[0].targetCell = 0;
        ActionEncodingProbe probe = new ActionEncodingProbe();
        try probe.hashActions(actions) returns (bytes32) {
            revert("Noncanonical HOLD was accepted");
        } catch (bytes memory reason) {
            bytes4 expectedSelector = IArena.InvalidActionEncoding.selector;
            require(
                reason.length == 36 && reason[0] == expectedSelector[0]
                    && reason[1] == expectedSelector[1] && reason[2] == expectedSelector[2]
                    && reason[3] == expectedSelector[3],
                "Unexpected invalid-action error"
            );
        }
    }
}
