import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readJson } from "./deployment.mjs";

let rules, cases;
const config = new URL("../config/", import.meta.url);
const groups = [
  "validation",
  "movement",
  "healing",
  "damage",
  "skillLock",
  "worldUpdate",
  "outcomes",
  "protocolDefaults",
];
const unit = (code) => {
  const found = rules.units.find((entry) => entry.code === code);
  assert.ok(found, `Unknown unit type ${code}.`);
  return found;
};
const medic = () => unit(4).skill;
const saboteur = () => unit(5).skill;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const distance = (a, b) =>
  Math.abs((a % 8) - (b % 8)) + Math.abs(Math.floor(a / 8) - Math.floor(b / 8));

function ray(from, to, range, obstacles = []) {
  if (
    ![from, to].every(
      (cell) => Number.isInteger(cell) && cell >= 0 && cell < 64,
    )
  )
    return false;
  if (from === to || distance(from, to) > range) return false;
  const sameRow = Math.floor(from / 8) === Math.floor(to / 8);
  if (!sameRow && from % 8 !== to % 8) return false;
  const step = Math.sign(to - from) * (sameRow ? 1 : 8);
  for (let cell = from + step; ; cell += step) {
    if (obstacles.includes(cell)) return false;
    if (cell === to) return true;
  }
}

function validateDefinitions() {
  assert.deepEqual(
    rules.scope,
    {
      width: 8,
      height: 8,
      players: 2,
      squadSize: 3,
      distinctTypes: true,
      orderedSlots: true,
      actionsPerLivingUnit: 1,
    },
    "Approved game scope",
  );
  assert.deepEqual(
    rules.match,
    {
      initialEnergy: 2,
      maxEnergy: 5,
      initialVictoryPoints: 0,
      resourceIncome: 1,
      controlAward: 2,
      controlCells: 4,
      victoryThreshold: 12,
      maxRounds: 20,
    },
    "Approved match parameters",
  );
  assert.deepEqual(
    rules.units.map((entry) => [
      entry.code,
      entry.name,
      entry.maxHp,
      entry.moveRange,
      entry.attack.range,
      entry.attack.damage,
      entry.skill.energyCost,
    ]),
    [
      [1, "Guardian", 10, 1, 1, 2, 1],
      [2, "Ranger", 6, 2, 3, 2, 2],
      [3, "Scout", 5, 3, 1, 1, 1],
      [4, "Medic", 7, 2, 1, 1, 2],
      [5, "Saboteur", 6, 2, 1, 1, 2],
    ],
    "Approved unit codes and numeric values",
  );
  assert.deepEqual(
    rules.units.map((entry) => [
      entry.attack.shape,
      entry.skill.target,
      entry.skill.stage,
    ]),
    [
      ["orthogonal-adjacent", "self", "Support"],
      ["orthogonal-ray", "cell", "Damage"],
      ["orthogonal-adjacent", "path", "Movement"],
      ["orthogonal-adjacent", "friendly-unit-id", "Support"],
      ["orthogonal-adjacent", "cell", "Status"],
    ],
    "Attack shapes, skill targets and effect stages",
  );
  assert.deepEqual(
    [
      unit(1).skill.totalDamageReduction,
      unit(2).skill.range,
      unit(2).skill.damage,
      unit(3).skill.range,
      medic().range,
      medic().amount,
      saboteur().range,
      saboteur().effectiveRoundOffset,
      saboteur().durationRounds,
      rules.damage.coverPerSourceReduction,
      rules.damage.coverFloor,
    ],
    [2, 3, 3, 4, 2, 2, 2, 1, 1, 1, 0],
    "Approved skill and defense values",
  );
  assert.deepEqual(
    rules.settlementOrder,
    [
      "Validate",
      "Movement",
      "Support",
      "Damage",
      "Status",
      "WorldUpdate",
      "Finalize",
    ],
    "Settlement stage order",
  );
  assert.deepEqual(
    rules.damage.order,
    [
      "per-source-cover",
      "sum-by-victim",
      "Guardian-shield",
      "simultaneous-HP-loss",
    ],
    "Damage reduction order",
  );
  assert.deepEqual(
    rules.outcomes.priority,
    ["elimination", "victory-threshold", "round-cap"],
    "Outcome priority",
  );
  assert.deepEqual(
    rules.outcomes.thresholdOrCapComparison,
    ["victory-points", "surviving-total-HP", "draw"],
    "Outcome tiebreak order",
  );
  assert.deepEqual(
    rules.validation.actionNames,
    ["HOLD", "MOVE", "ATTACK", "SKILL"],
    "Action names",
  );
  assert.deepEqual(
    rules.validation.freeActions,
    ["HOLD", "MOVE", "ATTACK"],
    "Free actions",
  );
  assert.deepEqual(rules.skillLock.blockedActions, ["SKILL"], "Locked actions");
  assert.equal(
    rules.healing.distance,
    "Manhattan-at-post-movement-positions",
    "Healing distance interpretation",
  );
  assert.equal(
    rules.validation.energyBudget,
    "sum-of-all-three-skill-costs-before-income",
    "Squad budget interpretation",
  );
  assert.equal(rules.validation.rayBlockers, "obstacles-only", "Ray blockers");
  assert.equal(rules.skillLock.stacking, "none", "Lock stacking");
  assert.equal(
    rules.outcomes.protocolDefault,
    "preserve-board-energy-VP-and-round-use-dedicated-reason",
    "Protocol default preservation",
  );
  assert.equal(cases.rules, "squad-rules.json", "Case rule source");
  assert.deepEqual(
    Object.keys(cases)
      .filter((key) => Array.isArray(cases[key]))
      .sort(),
    [...groups].sort(),
    "Supported case groups",
  );
}

function budget(types, actions, energy) {
  assert.equal(types.length, actions.length, "Budget inputs must align.");
  const requiredEnergy = sum(
    types.map((code, index) => {
      assert.ok(
        rules.validation.actionNames.includes(actions[index]),
        "Unknown budget action",
      );
      return actions[index] === "SKILL" ? unit(code).skill.energyCost : 0;
    }),
  );
  const valid = requiredEnergy <= energy;
  return {
    requiredEnergy,
    bundle: valid ? "allow" : "reject",
    energyAfter: valid ? energy - requiredEnergy : energy,
    stateChanged: valid && requiredEnergy > 0,
  };
}

function validation(given, check) {
  switch (check) {
    case "basic-actions": {
      const types = given.unitTypes.map(unit);
      return {
        moveLegal: types.every(
          (entry) => given.moveSteps > 0 && given.moveSteps <= entry.moveRange,
        ),
        attackLegal: types.every(
          (entry) =>
            given.attackDistance > 0 &&
            given.attackDistance <= entry.attack.range,
        ),
        attackDamage: types[0].attack.damage,
        energySpent: 0,
      };
    }
    case "locked-actions":
      given.unitTypes.forEach(unit);
      return {
        SKILL: given.lockedRound === given.round ? "reject" : "allow",
        HOLD: "allow",
        MOVE: "allow-if-otherwise-legal",
        ATTACK: "allow-if-otherwise-legal",
      };
    case "dead-actions":
      return {
        allowed: given.actions.filter(
          (action) => given.hp > 0 || action === "HOLD",
        ),
        rejected: given.actions.filter(
          (action) => given.hp === 0 && action !== "HOLD",
        ),
        energySpent: 0,
      };
    case "budget":
      if (given.squadTypes) {
        assert.equal(
          given.squadTypes.length,
          rules.scope.squadSize,
          "Squad budget slot count",
        );
        assert.equal(
          new Set(given.squadTypes).size,
          rules.scope.squadSize,
          "Squad types must differ.",
        );
      }
      return budget(
        given.squadTypes ?? [given.unitType],
        given.actions ?? [given.action],
        given.energy,
      );
    case "heal-targets": {
      const legal = given.targets.map(
        (target) =>
          target.owner === given.casterOwner && target.roundStartHp > 0,
      );
      return {
        bothTargets: legal.every(Boolean) ? "allow" : "reject-at-Validate",
        energySpent: legal.every(Boolean) ? medic().energyCost : 0,
        resurrected: legal.some(
          (value, index) => value && given.targets[index].roundStartHp === 0,
        ),
      };
    }
    case "lock-rays":
      return {
        legalTargets: given.targetVariants.map((target) =>
          ray(
            given.casterCell,
            target.cell,
            saboteur().range,
            target.obstacles,
          ),
        ),
      };
    default:
      throw new Error(`Unsupported validation calculation: ${check}`);
  }
}

function movement(given) {
  const origins = given.units.map((entry) => entry.cell);
  const valid = given.units.every((entry) => {
    if (
      entry.action !== "MOVE" &&
      !(entry.action === "SKILL" && entry.type === 3)
    )
      return false;
    const limit =
      entry.action === "SKILL"
        ? unit(entry.type).skill.range
        : unit(entry.type).moveRange;
    const path = [entry.cell, ...entry.path];
    return (
      entry.path.length > 0 &&
      entry.path.length <= limit &&
      new Set(path).size === path.length &&
      entry.path.every(
        (cell, index) =>
          Number.isInteger(cell) &&
          cell >= 0 &&
          cell < 64 &&
          distance(path[index], cell) === 1 &&
          !origins.includes(cell) &&
          !(given.obstacles ?? []).includes(cell),
      )
    );
  });
  const endpoints = given.units.map((entry) => entry.path.at(-1));
  const moved = endpoints.map(
    (cell) => valid && endpoints.filter((other) => other === cell).length === 1,
  );
  return {
    bundle: valid ? "allow" : "reject-at-Validate",
    stateChanged: moved.some(Boolean),
    cells: given.units.map((entry, index) =>
      moved[index] ? endpoints[index] : entry.cell,
    ),
    moved,
    energySpent: given.units.map((entry) =>
      valid && entry.action === "SKILL" ? unit(entry.type).skill.energyCost : 0,
    ),
  };
}

function healing(given) {
  assert.ok(
    [given.casterCell, given.targetCell].every(
      (cell) => Number.isInteger(cell) && cell >= 0 && cell < 64,
    ),
    "Healing cell inputs",
  );
  assert.ok(
    Number.isInteger(given.hp) && given.hp >= 0 && given.hp <= given.maxHp,
    "Healing HP input",
  );
  if (given.targetPath)
    assert.equal(
      given.targetPath.at(-1),
      given.targetCell,
      "Healing moved target cell",
    );
  const eligible =
    given.hp > 0 &&
    distance(given.casterCell, given.targetCell) <= medic().range;
  const healed = eligible
    ? Math.min(medic().amount, given.maxHp - given.hp)
    : 0;
  const hpAfterSupport = given.hp + healed;
  const hpAfterDamage = Math.max(
    0,
    hpAfterSupport - (given.incomingDamage ?? 0),
  );
  return {
    staticTarget: given.hp > 0 ? "allow" : "reject",
    healed,
    hpAfterSupport,
    hpAfterDamage,
    alive: hpAfterDamage > 0,
    discardedHealing: eligible ? medic().amount - healed : medic().amount,
    resurrected: given.hp === 0 && hpAfterDamage > 0,
    energySpent: medic().energyCost,
    casterHpAfterDamage: Math.max(
      0,
      (given.casterHp ?? unit(4).maxHp) - (given.casterIncomingDamage ?? 0),
    ),
  };
}

function reducedDamage(hp, sources, cover, shield) {
  const sourcesAfterCover = sources.map((value) =>
    Math.max(
      rules.damage.coverFloor,
      value - (cover ? rules.damage.coverPerSourceReduction : 0),
    ),
  );
  const aggregate = sum(sourcesAfterCover);
  const shielded = shield
    ? Math.min(aggregate, unit(1).skill.totalDamageReduction)
    : 0;
  const damageTaken = Math.min(hp, aggregate - shielded);
  return {
    sourcesAfterCover,
    aggregate,
    shielded,
    damageTaken,
    hpAfterDamage: hp - damageTaken,
  };
}

function damage(given) {
  if (given.incomingSources)
    return reducedDamage(
      given.hp,
      given.incomingSources,
      given.onCover,
      given.shield,
    );
  if (given.attackerCell !== undefined) {
    const legal = ray(
      given.attackerCell,
      given.targetCell,
      unit(2).skill.range,
    );
    const hit = legal && given.enemyMovedCell === given.targetCell;
    const result = reducedDamage(
      given.enemyHp,
      hit ? [unit(2).skill.damage] : [],
      false,
      false,
    );
    return {
      staticShot: legal ? "allow" : "reject",
      damageTaken: result.damageTaken,
      enemyHpAfterDamage: result.hpAfterDamage,
      energySpent: legal ? unit(2).skill.energyCost : 0,
    };
  }
  const attackOrder = given.attackerCells.map((_, index) => index);
  function simultaneous(order) {
    return given.hp.map(
      (hp, victim) =>
        reducedDamage(
          hp,
          order
            .filter(
              (attacker) =>
                attacker !== victim &&
                given.targetCells[attacker] === given.attackerCells[victim],
            )
            .map((attacker) => given.damage[attacker]),
          given.onCover[victim],
          false,
        ).hpAfterDamage,
    );
  }
  const hpAfterDamage = simultaneous(attackOrder);
  const reversed = simultaneous([...attackOrder].reverse());
  return {
    hpAfterDamage,
    appliedAttacks: attackOrder.filter((attacker) =>
      given.attackerCells.some(
        (cell, index) =>
          index !== attacker && given.targetCells[attacker] === cell,
      ),
    ).length,
    iterationOrderChangesResult: hpAfterDamage.some(
      (hp, index) => hp !== reversed[index],
    ),
  };
}

function skillLock(given) {
  const nextRound = given.round + saboteur().effectiveRoundOffset;
  if (given.currentSkill === "Shield") {
    const result = reducedDamage(
      given.hp,
      [given.incomingDamage],
      given.onCover,
      true,
    );
    return {
      shielded: result.shielded,
      hpAfterDamage: result.hpAfterDamage,
      lockedRound:
        given.validLockHit && result.hpAfterDamage > 0 ? nextRound : 0,
      targetSkillEnergySpent: unit(1).skill.energyCost,
      casterSkillEnergySpent: saboteur().energyCost,
    };
  }
  if (given.newLockHit !== undefined) {
    const lockedRoundAfterWorldUpdate =
      given.newLockHit && given.hpAfterDamage > 0 ? nextRound : 0;
    return {
      lockedRoundAfterWorldUpdate,
      skillAllowedNextRound: lockedRoundAfterWorldUpdate !== nextRound,
      currentAttackApplies: given.action === "ATTACK",
      blockedSkillRounds: lockedRoundAfterWorldUpdate
        ? [lockedRoundAfterWorldUpdate]
        : [],
    };
  }
  if (given.occupantsAfterMovement) {
    const lockApplied = given.occupantsAfterMovement.some(
      (occupant) => occupant === "enemy",
    );
    return {
      bothTargets: lockApplied ? "hit" : "legal-miss",
      lockApplied,
      energySpent: saboteur().energyCost,
    };
  }
  const lockApplied =
    given.enemyHpAfterDamage > 0 && given.enemyMovedCell === given.targetCell;
  const targetLockedRound = lockApplied ? nextRound : 0;
  return {
    lockApplied,
    targetLockedRound,
    currentSkillCancelled: targetLockedRound === given.round,
    lockedRoundAfterWorldUpdate: targetLockedRound,
    positionAfterWorldUpdate:
      given.enemyHpAfterDamage > 0 ? given.enemyMovedCell : "cleared",
    energySpent: saboteur().energyCost,
  };
}

function worldUpdate(given) {
  if (given.resources) {
    const incomeBeforeCap = ["A", "B"].map((owner) =>
      sum(
        given.resources.map((cell) =>
          given.occupantsAfterDamage.some(
            (entry) =>
              entry.cell === cell && entry.owner === owner && entry.hp > 0,
          )
            ? rules.match.resourceIncome
            : 0,
        ),
      ),
    );
    const energyAfterIncome = given.energyAfterCosts.map((energy, index) =>
      Math.min(rules.match.maxEnergy, energy + incomeBeforeCap[index]),
    );
    return {
      incomeBeforeCap,
      energyAfterIncome,
      creditedEnergy: energyAfterIncome.map(
        (energy, index) => energy - given.energyAfterCosts[index],
      ),
    };
  }
  const survivingControlCounts =
    given.survivingControlCounts ??
    ["A", "B"].map(
      (owner) =>
        given.occupantsAfterDamage.filter(
          (entry) =>
            entry.owner === owner &&
            entry.hp > 0 &&
            given.controlCells.includes(entry.cell),
        ).length,
    );
  return {
    survivingControlCounts,
    victoryPointsGained: survivingControlCounts.map((count, index) =>
      count > survivingControlCounts[1 - index] ? rules.match.controlAward : 0,
    ),
  };
}

function outcomes(given) {
  const [hpA, hpB] = given.survivingHp;
  let reason = "None",
    outcome = "Ongoing";
  if (!hpA || !hpB) {
    reason = !hpA && !hpB ? "MutualElimination" : "Elimination";
    outcome = !hpA && !hpB ? "Draw" : hpA ? "A" : "B";
  } else if (
    Math.max(...given.victoryPoints) >= rules.match.victoryThreshold ||
    given.round === rules.match.maxRounds
  ) {
    reason =
      Math.max(...given.victoryPoints) >= rules.match.victoryThreshold
        ? "VictoryPoints"
        : "RoundLimit";
    const points = given.victoryPoints[0] - given.victoryPoints[1];
    const comparison = points || hpA - hpB;
    outcome = comparison > 0 ? "A" : comparison < 0 ? "B" : "Draw";
  }
  return {
    outcome,
    reason,
    round: given.round + (outcome === "Ongoing" ? 1 : 0),
  };
}

function protocolDefaults(given) {
  assert.ok(["Commit", "Reveal"].includes(given.phase), "Default phase");
  assert.equal(given.expired, true, "Default cases must be expired.");
  const present = given.submitted.flatMap((submitted, index) =>
    submitted ? [index] : [],
  );
  assert.ok(
    present.length < rules.scope.players,
    "A default requires a missing submission.",
  );
  return {
    outcome: present.length === 1 ? ["A", "B"][present[0]] : "Draw",
    reason: `${given.phase}Timeout`,
    boardEnergyVpAndRound: "unchanged",
  };
}

const calculators = {
  validation,
  movement,
  healing,
  damage,
  skillLock,
  worldUpdate,
  outcomes,
  protocolDefaults,
};
function compareCase(group, entry) {
  const label = `${group}/${entry.name}`;
  try {
    const actual = calculators[group](entry.given, entry.check);
    assert.ok(Object.keys(entry.expected).length > 0, "Missing expectations");
    for (const [field, expected] of Object.entries(entry.expected)) {
      assert.ok(Object.hasOwn(actual, field), `${field}: missing calculation`);
      assert.deepEqual(actual[field], expected, field);
    }
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
}

try {
  rules = await readJson(fileURLToPath(new URL("squad-rules.json", config)));
  cases = await readJson(fileURLToPath(new URL("squad-cases.json", config)));
  validateDefinitions();
  const names = new Set();
  for (const group of groups) {
    assert.ok(cases[group].length > 0, `Missing ${group} cases.`);
    for (const entry of cases[group]) {
      assert.ok(
        entry.name && !names.has(entry.name),
        `Missing or duplicate case name: ${entry.name}`,
      );
      names.add(entry.name);
      compareCase(group, entry);
    }
    console.log(
      `PASS: squad-rule consistency ${group}: ${cases[group].length} cases.`,
    );
  }
  // An incorrect expectation must fail instead of being copied into a passing report.
  const incorrect = structuredClone(cases.healing[0]);
  incorrect.expected.hpAfterSupport += 1;
  assert.throws(
    () => compareCase("healing", incorrect),
    assert.AssertionError,
    "The checker must reject an incorrect healing expectation.",
  );
  console.log(
    `PASS: squad-rule consistency: approved parameters and ${names.size} stage-local cases matched; incorrect-expectation self-check passed.`,
  );
  console.log(
    "Scope: design data and arithmetic only. New Solidity/Go gameplay is not exercised by this check.",
  );
} catch (error) {
  console.error(`FAIL: squad-rule consistency: ${error.message}`);
  if (error.code === "ERR_ASSERTION") {
    console.error(`Expected: ${JSON.stringify(error.expected)}`);
    console.error(`Actual: ${JSON.stringify(error.actual)}`);
  }
  process.exitCode = 1;
}
