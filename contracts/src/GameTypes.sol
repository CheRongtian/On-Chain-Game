// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

library GameTypes {
    uint8 internal constant BOARD_SIZE = 8;
    uint8 internal constant CELL_COUNT = 64;
    uint8 internal constant MAP_ID = 1;
    uint8 internal constant SQUAD_SIZE = 3;
    uint8 internal constant UNIT_COUNT = 6;
    uint8 internal constant MAX_PATH_LENGTH = 4;
    uint8 internal constant NO_CELL = 255;
    uint8 internal constant INITIAL_ENERGY = 2;
    uint8 internal constant MAX_ENERGY = 5;
    uint8 internal constant MAX_ROUNDS = 20;
    uint8 internal constant VICTORY_THRESHOLD = 12;
    uint32 internal constant PHASE_DURATION = 600;
    uint32 internal constant ROOM_LIFETIME = 86400;
    uint8 internal constant SCOUT_MOVE_RANGE = 3;
    uint8 internal constant RANGER_ATTACK_RANGE = 3;
    uint8 internal constant POWER_SHOT_DAMAGE = 3;

    // Enum order and struct field order define the ABI encoding.
    enum ActionKind {
        Hold,
        Move,
        Attack,
        Shield,
        PowerShot,
        Dash
    }

    enum UnitKind {
        None,
        Guardian,
        Ranger,
        Scout
    }

    enum Phase {
        None,
        WaitingForOpponent,
        Commit,
        Reveal,
        Resolvable,
        Finished,
        Cancelled,
        Expired
    }

    enum Outcome {
        None,
        PlayerA,
        PlayerB,
        Draw
    }

    enum EndReason {
        None,
        Elimination,
        MutualElimination,
        VictoryPoints,
        RoundLimit,
        CommitTimeout,
        RevealTimeout
    }

    // Bundles follow squad slot order. Dead slots use Hold.
    // Unused targets are NO_CELL. Unused path entries are zero.
    struct Action {
        ActionKind kind;
        uint8 targetCell;
        uint8 pathLength;
        uint8[4] path;
    }

    // Array index is the stable unit ID; 0-2 belong to A and 3-5 to B.
    // A dead unit retains its type, with hp = 0 and cell = NO_CELL.
    struct UnitState {
        UnitKind unitType;
        uint8 cell;
        uint8 hp;
    }

    struct PlayerState {
        uint8 energy;
        uint8 victoryPoints;
    }

    // round is the next round to resolve while ongoing, or the terminal round.
    // Initial state is round 1; continuing settlement increments it before hashing.
    struct BattleState {
        uint8 mapId;
        uint8 round;
        PlayerState[2] players;
        UnitState[6] units;
        Outcome outcome;
        EndReason reason;
    }

    struct MatchContext {
        uint256 chainId;
        address arena;
        uint256 matchId;
    }

    struct MapConfig {
        uint8 mapId;
        uint8 width;
        uint8 height;
        uint64 obstacles;
        uint64 resources;
        uint64 controlZone;
        uint8[3] spawnsA;
        uint8[3] spawnsB;
    }

    // Unit arrays follow Guardian, Ranger, Scout order.
    struct Rules {
        uint8 initialEnergy;
        uint8 maxEnergy;
        uint8 maxRounds;
        uint8 victoryThreshold;
        uint8 resourceIncome;
        uint8 controlAward;
        uint32 phaseDuration;
        uint32 roomLifetime;
        uint8[3] maxHp;
        uint8[3] moveRange;
        uint8[3] attackRange;
        uint8[3] attackDamage;
        uint8[3] skillCost;
        uint8 shieldReduction;
        uint8 powerShotDamage;
        uint8 dashRange;
    }

    // Before joining: B is address(0), round/stateHash are zero, and outcome/reason are None.
    // phaseDeadline is zero outside Commit/Reveal; joinDeadline retains the room's expiry.
    struct MatchSummary {
        address[2] players;
        uint8 mapId;
        bytes32 rulesHash;
        Phase phase;
        uint8 round;
        uint64 joinDeadline;
        uint64 phaseDeadline;
        bytes32 stateHash;
        Outcome outcome;
        EndReason reason;
    }

    // Flags distinguish an absent commitment from an accepted zero hash.
    struct RoundStatus {
        bytes32[2] commitments;
        bool[2] committed;
        bool[2] revealed;
    }

    function defaultRules() internal pure returns (Rules memory rules) {
        rules.initialEnergy = INITIAL_ENERGY;
        rules.maxEnergy = MAX_ENERGY;
        rules.maxRounds = MAX_ROUNDS;
        rules.victoryThreshold = VICTORY_THRESHOLD;
        rules.resourceIncome = 1;
        rules.controlAward = 2;
        rules.phaseDuration = PHASE_DURATION;
        rules.roomLifetime = ROOM_LIFETIME;
        rules.maxHp = [uint8(10), 6, 5];
        rules.moveRange = [uint8(1), 2, SCOUT_MOVE_RANGE];
        rules.attackRange = [uint8(1), RANGER_ATTACK_RANGE, 1];
        rules.attackDamage = [uint8(2), 2, 1];
        rules.skillCost = [uint8(1), 2, 1];
        rules.shieldReduction = 2;
        rules.powerShotDamage = POWER_SHOT_DAMAGE;
        rules.dashRange = MAX_PATH_LENGTH;
    }

    function defaultMap() internal pure returns (MapConfig memory map) {
        map.mapId = MAP_ID;
        map.width = BOARD_SIZE;
        map.height = BOARD_SIZE;
        map.obstacles = 0x0000_4200_0042_0000;
        map.resources = 0x0000_2000_0004_0000;
        map.controlZone = 0x0000_0018_1800_0000;
        map.spawnsA = [uint8(8), 24, 40];
        map.spawnsB = [uint8(55), 39, 23];
    }

    function initialBattleState() internal pure returns (BattleState memory state) {
        Rules memory rules = defaultRules();
        MapConfig memory map = defaultMap();
        state.mapId = map.mapId;
        state.round = 1;
        state.players[0].energy = rules.initialEnergy;
        state.players[1].energy = rules.initialEnergy;
        for (uint256 slot = 0; slot < UNIT_COUNT; ++slot) {
            uint256 localSlot = slot % SQUAD_SIZE;
            uint8 cell = slot < SQUAD_SIZE ? map.spawnsA[localSlot] : map.spawnsB[localSlot];
            state.units[slot] = UnitState({
                unitType: UnitKind(localSlot + 1), cell: cell, hp: rules.maxHp[localSlot]
            });
        }
    }
}
