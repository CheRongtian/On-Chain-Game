// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadParameters as Parameters } from "./SquadParameters.sol";

// These literals define the frozen ABI widths and numeric rule profile.
// forge-lint: disable-start(literal-instead-of-constant)

library SquadCodec {
    error InvalidProtocol();

    bytes32 internal constant RULESET_DOMAIN = keccak256("OTA_RULESET_V2");
    bytes32 internal constant SQUAD_DOMAIN = keccak256("OTA_SQUAD_V2");
    bytes32 internal constant ACTION_DOMAIN = keccak256("OTA_ACTION_V2");
    bytes32 internal constant STATE_DOMAIN = keccak256("OTA_STATE_V2");

    struct Context {
        uint256 chainId;
        address arena;
        uint256 matchId;
    }

    struct Action {
        uint8 actionType;
        uint8 targetCell;
        uint8 targetUnit;
        uint8 pathLength;
        uint32 pathBits;
    }

    struct Unit {
        uint8 unitType;
        uint8 position;
        uint8 hp;
        bool alive;
        uint16 lockedRound;
    }

    struct State {
        uint8 mapId;
        bool battleStarted;
        uint16 completedRound;
        Unit[6] units;
        uint8[2] energy;
        uint8[2] victoryPoints;
        uint8 outcome;
        uint8 reason;
    }

    struct Effects {
        uint8[2] energySpent;
        bool[6] moved;
        uint8[6] healed;
        uint8[6] coverReduced;
        uint8[6] shieldReduced;
        uint8[6] damageTaken;
        uint16[6] lockedRoundApplied;
        uint8[2] energyGained;
        uint8[2] victoryPointsGained;
    }

    struct Rules {
        bytes32 semanticsId;
        uint8[8] matchRules;
        uint8[5][5] unitRules;
        uint8[10] skillRules;
        uint32[5] windows;
        uint16[3] schemas;
        bytes32[3] mapHashes;
    }

    struct SquadInput {
        Context context;
        address player;
        bytes32 rulesetId;
        uint8[3] unitTypes;
        bytes32 salt;
    }

    struct ActionInput {
        Context context;
        uint16 round;
        address player;
        bytes32 rulesetId;
        uint8 side;
        uint8[3] unitTypes;
        bool[3] alive;
        uint16[3] lockedRound;
        Action[3] actions;
        bytes32 salt;
    }

    struct StateInput {
        Context context;
        bytes32 rulesetId;
        State state;
    }

    struct MatchSummary {
        address[2] players;
        uint8 mapId;
        bytes32 mapHash;
        bytes32 rulesetId;
        uint8 phase;
        uint16 activeRound;
        uint64 joinDeadline;
        uint64 phaseDeadline;
        bytes32 stateHash;
        uint8 outcome;
        uint8 reason;
    }

    struct SquadStatus {
        bytes32[2] commitments;
        bool[2] committed;
        bool[2] revealed;
        uint8[3][2] unitTypes;
    }

    struct RoundStatus {
        bytes32[2] commitments;
        bool[2] committed;
        bool[2] revealed;
    }

    // Internal storage only; published getter tuples retain their frozen layouts.
    struct MatchData {
        MatchSummary summary;
        State battle;
        SquadStatus squad;
        RoundStatus turn;
        Action[3][2] revealedActions;
    }

    struct Map {
        uint8 mapId;
        uint8 width;
        uint8 height;
        uint64 obstacles;
        uint64 cover;
        uint64 resources;
        uint64 controlZone;
        uint8[3] spawnsA;
        uint8[3] spawnsB;
        bytes32 mapHash;
    }

    function _require(bool condition) private pure {
        // Rejection guards must remain active when validating fixed-size bundles.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (!condition) revert InvalidProtocol();
    }

    function domain(uint8 index) internal pure returns (bytes32) {
        if (index == 0) return RULESET_DOMAIN;
        if (index == 1) return SQUAD_DOMAIN;
        if (index == 2) return ACTION_DOMAIN;
        if (index == 3) return STATE_DOMAIN;
        revert InvalidProtocol();
    }

    function validateSquad(uint8[3] memory types_) internal pure {
        for (uint256 i = 0; i < Parameters.SQUAD_SIZE; ++i) {
            _require(types_[i] >= 1 && types_[i] <= Parameters.TYPE_COUNT);
            for (uint256 j = 0; j < i; ++j) {
                _require(types_[i] != types_[j]);
            }
        }
    }

    function rulesEncoding(Rules memory rules) internal pure returns (bytes memory) {
        return abi.encode(RULESET_DOMAIN, rules);
    }

    function squadEncoding(SquadInput memory input) internal pure returns (bytes memory) {
        validateSquad(input.unitTypes);
        return abi.encode(
            SQUAD_DOMAIN, input.context, input.player, input.rulesetId, input.unitTypes, input.salt
        );
    }

    function actionEncoding(ActionInput memory input) internal pure returns (bytes memory) {
        _require(input.round >= 1 && input.round <= Parameters.MAX_ROUNDS && input.side <= 1);
        validateSquad(input.unitTypes);
        for (uint256 slot = 0; slot < 3; ++slot) {
            _validateAction(input, slot);
        }
        return abi.encode(
            ACTION_DOMAIN,
            input.context,
            input.round,
            input.player,
            input.rulesetId,
            input.actions,
            input.salt
        );
    }

    function _validateAction(ActionInput memory input, uint256 slot) private pure {
        Action memory action = input.actions[slot];
        uint8 unitType = input.unitTypes[slot];
        _require(action.actionType <= 3);
        _require(input.alive[slot] || action.actionType == 0);
        _require(input.lockedRound[slot] != input.round || action.actionType != 3);
        bool skill = action.actionType == 3;
        bool moves = action.actionType == 1 || (skill && unitType == 3);
        if (moves) {
            uint8 limit = skill ? Parameters.skillRules()[2] : Parameters.unitRule(unitType)[1];
            _require(action.targetCell == 255 && action.targetUnit == 255);
            _require(action.pathLength >= 1 && action.pathLength <= limit);
        } else {
            _require(action.pathLength == 0);
            bool targetsCell = action.actionType == 2 || (skill && (unitType == 2 || unitType == 5));
            bool targetsUnit = skill && unitType == 4;
            _require(targetsCell ? action.targetCell < 64 : action.targetCell == 255);
            _require(targetsUnit ? action.targetUnit < 6 : action.targetUnit == 255);
            if (targetsUnit) {
                _require(action.targetUnit / 3 == input.side);
                _require(input.alive[action.targetUnit % 3]);
            }
        }
        _require((uint256(action.pathBits) >> (uint256(action.pathLength) * 6)) == 0);
        for (uint256 i = 0; i < action.pathLength; ++i) {
            uint256 cell = (uint256(action.pathBits) >> (i * 6)) & 63;
            for (uint256 j = 0; j < i; ++j) {
                _require(cell != ((uint256(action.pathBits) >> (j * 6)) & 63));
            }
            if (i > 0) {
                uint256 previous = (uint256(action.pathBits) >> ((i - 1) * 6)) & 63;
                uint256 dx =
                    cell % 8 > previous % 8 ? cell % 8 - previous % 8 : previous % 8 - cell % 8;
                uint256 dy =
                    cell / 8 > previous / 8 ? cell / 8 - previous / 8 : previous / 8 - cell / 8;
                _require(dx + dy == 1);
            }
        }
    }

    function stateEncoding(StateInput memory input) internal pure returns (bytes memory) {
        State memory state = input.state;
        uint64 obstacles = Parameters.terrain(state.mapId)[0];
        _require(state.completedRound <= Parameters.MAX_ROUNDS);
        _require(state.outcome <= 3 && state.reason <= 8);
        _require((state.outcome == 0) == (state.reason == 0));
        if (!state.battleStarted) {
            _require(state.completedRound == 0 && (state.reason == 0 || state.reason >= 7));
            for (uint256 p = 0; p < 2; ++p) {
                _require(state.energy[p] == 0 && state.victoryPoints[p] == 0);
            }
            for (uint256 i = 0; i < 6; ++i) {
                Unit memory unit = state.units[i];
                _require(
                    unit.unitType == 0 && unit.position == 255 && unit.hp == 0 && !unit.alive
                        && unit.lockedRound == 0
                );
            }
        } else {
            _require(state.reason <= 6);
            _require(
                state.completedRound < Parameters.MAX_ROUNDS
                    || (state.outcome != 0 && state.reason <= 4)
            );
            _require(state.reason < 1 || state.reason > 4 || state.completedRound > 0);
            uint8[3] memory types_;
            uint64 occupied = 0;
            for (uint256 p = 0; p < 2; ++p) {
                _require(state.energy[p] <= Parameters.MAX_ENERGY);
                for (uint256 slot = 0; slot < 3; ++slot) {
                    types_[slot] = state.units[p * 3 + slot].unitType;
                }
                validateSquad(types_);
            }
            for (uint256 i = 0; i < 6; ++i) {
                Unit memory unit = state.units[i];
                _require(
                    unit.hp <= Parameters.unitRule(unit.unitType)[0] && unit.alive == (unit.hp > 0)
                );
                if (unit.alive) {
                    _require(unit.position < 64);
                    uint64 bit = uint64(1) << unit.position;
                    _require((occupied & bit) == 0 && (obstacles & bit) == 0);
                    occupied |= bit;
                    _require(
                        unit.lockedRound == 0
                            || (state.completedRound > 0
                                && unit.lockedRound == state.completedRound + 1)
                    );
                } else {
                    _require(unit.position == 255 && unit.lockedRound == 0);
                }
            }
        }
        return abi.encode(STATE_DOMAIN, input.context, input.rulesetId, state);
    }
}
// forge-lint: disable-end(literal-instead-of-constant)
