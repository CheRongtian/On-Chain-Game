// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { SquadCodec } from "../src/SquadCodec.sol";
import { SquadRules } from "../src/SquadRules.sol";
import { SquadBattleProbe } from "../script/CheckSquadBattle.s.sol";
import { SquadSafetySupport as Support } from "./SquadSafetySupport.sol";

// The handler stores only its disposable rule-model state; bounded checks and calls are intentional.
// forge-lint: disable-start(literal-instead-of-constant,require-revert-in-loop,calls-loop)
contract SquadRuleHandler {
    SquadBattleProbe private immutable PROBE;
    SquadCodec.State private current;
    bytes32 public stateHash;
    uint256 public steps;
    uint256 public games;
    uint256 public settlements;
    uint256 public moves;
    uint256 public healing;
    uint256 public damage;
    uint256 public locks;
    uint256 public deaths;
    uint256 public terminals;
    uint256 public rejections;

    constructor() {
        PROBE = new SquadBattleProbe();
        _store(Support.preludeState());
        _accept(Support.preludeOrders(false));
        require(
            current.units[0].hp == 2 && current.units[0].lockedRound == 20,
            "Prelude missed heal/shield/lock ordering"
        );
        require(moves == 1 && healing == 2 && damage == 1 && locks == 1, "Prelude missed effects");
        _accept(Support.preludeOrders(true));
        require(
            current.outcome == 2 && current.completedRound == 20 && deaths == 1,
            "Prelude missed terminal/death"
        );
        _reject(Support.holds());
        _start(0);
    }

    function step(uint256 seed) external {
        ++steps;
        if (current.outcome != 0) {
            _reject(Support.holds());
            _start(seed);
        } else if (seed % 5 == 0) {
            SquadCodec.Action[3][2] memory invalid = Support.holds();
            invalid[0][0].targetCell = 0;
            _reject(invalid);
        } else {
            _accept(Support.generate(current, seed));
        }
    }

    function check() external view {
        Support.checkState(current);
        require(
            stateHash == SquadRules.hashState(Support.context(), current),
            "Stored model hash differs"
        );
        require(
            settlements >= 2 && moves > 0 && healing > 0 && damage > 0 && locks > 0 && deaths > 0
                && terminals > 0 && rejections > 0,
            "Vacuous rule invariant"
        );
    }

    function _start(uint256 seed) private {
        // The modulo selects one of the three frozen maps.
        // forge-lint: disable-next-line(unsafe-typecast)
        _store(Support.initialized(uint8(1 + seed % 3), seed / 3));
        stateHash = SquadRules.hashState(Support.context(), current);
        ++games;
    }

    function _accept(SquadCodec.Action[3][2] memory actions) private {
        SquadCodec.State memory before_ = current;
        SquadBattleProbe.Output memory output =
            Support.run(PROBE, Support.context(), before_, actions);
        for (uint256 id = 0; id < 6; ++id) {
            if (output.effects.moved[id]) ++moves;
            healing += output.effects.healed[id];
            damage += output.effects.damageTaken[id];
            if (output.effects.lockedRoundApplied[id] > 0) ++locks;
            if (before_.units[id].alive && !output.next.units[id].alive) ++deaths;
        }
        _store(output.next);
        stateHash = output.stateHash;
        ++settlements;
        if (current.outcome != 0) ++terminals;
    }

    function _reject(SquadCodec.Action[3][2] memory actions) private {
        SquadCodec.State memory before_ = current;
        bytes32 beforeHash = stateHash;
        Support.reject(PROBE, before_, actions);
        require(
            Support.sameState(current, before_) && stateHash == beforeHash,
            "Rejected step changed model state"
        );
        ++rejections;
    }

    function _store(SquadCodec.State memory state) private {
        // Explicit field copies preserve the project's existing non-IR Solidity pipeline.
        current.mapId = state.mapId;
        current.battleStarted = state.battleStarted;
        current.completedRound = state.completedRound;
        current.outcome = state.outcome;
        current.reason = state.reason;
        for (uint256 side = 0; side < 2; ++side) {
            current.energy[side] = state.energy[side];
            current.victoryPoints[side] = state.victoryPoints[side];
        }
        for (uint256 id = 0; id < 6; ++id) {
            current.units[id].unitType = state.units[id].unitType;
            current.units[id].position = state.units[id].position;
            current.units[id].hp = state.units[id].hp;
            current.units[id].alive = state.units[id].alive;
            current.units[id].lockedRound = state.units[id].lockedRound;
        }
    }
}
// forge-lint: disable-end(literal-instead-of-constant,require-revert-in-loop,calls-loop)
