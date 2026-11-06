import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { readJson } from "./deployment.mjs";

function initialState(row, rules, maps) {
  const map = maps.find((value) => value.mapId === row.mapId);
  const squads =
    row.side === 0 ? [row.squad, row.opponent] : [row.opponent, row.squad];
  return {
    mapId: row.mapId,
    battleStarted: true,
    completedRound: 0,
    units: squads.flatMap((types, side) =>
      types.map((type, slot) => ({
        unitType: type,
        position: map.spawns[side === 0 ? "A" : "B"][slot],
        hp: rules.units[type - 1].maxHp,
        alive: true,
        lockedRound: 0,
      })),
    ),
    energy: [2, 2],
    victoryPoints: [0, 0],
    outcome: 0,
    reason: 0,
  };
}

function emptyEffects() {
  return {
    energySpent: [0, 0],
    moved: Array(6).fill(false),
    healed: Array(6).fill(0),
    coverReduced: Array(6).fill(0),
    shieldReduced: Array(6).fill(0),
    damageTaken: Array(6).fill(0),
    lockedRoundApplied: Array(6).fill(0),
    energyGained: [0, 0],
    victoryPointsGained: [0, 0],
  };
}

// Check the authored checkpoints' conservation laws without resolving attack/skill hits.
function checkRound(entry, rules, maps) {
  const { input, expected } = entry;
  const { state, actions, round } = input;
  const stages = expected.stages,
    effects = expected.effects,
    next = expected.state;
  assert.equal(round, state.completedRound + 1, `${entry.name}: active round`);
  assert.deepEqual(
    Object.keys(stages),
    rules.settlementOrder,
    `${entry.name}: seven stages`,
  );
  assert.equal(actions.length, 2);
  const spent = actions.map((bundle, side) => {
    assert.equal(bundle.length, 3);
    return bundle.reduce(
      (sum, action, slot) =>
        sum +
        (action.actionType === 3
          ? rules.units[state.units[side * 3 + slot].unitType - 1].skill
              .energyCost
          : 0),
      0,
    );
  });
  assert.deepEqual(spent, effects.energySpent, `${entry.name}: reserved cost`);
  assert.deepEqual(stages.Validate.energySpent, spent);
  spent.forEach((value, side) =>
    assert.ok(value <= state.energy[side], `${entry.name}: starting budget`),
  );
  const positions = state.units.map((unit, id) => {
    const action = actions[Math.floor(id / 3)][id % 3];
    if (!effects.moved[id]) return unit.position;
    assert.ok(
      action.actionType === 1 ||
        (action.actionType === 3 && unit.unitType === 3),
    );
    assert.ok(action.pathLength > 0);
    return Number(
      (BigInt(action.pathBits) >> BigInt((action.pathLength - 1) * 6)) & 63n,
    );
  });
  assert.deepEqual(
    stages.Movement.positions,
    positions,
    `${entry.name}: declared successful endpoints`,
  );
  const hp = state.units.map((unit, id) => {
    assert.ok(
      Number.isInteger(effects.healed[id]) &&
        effects.healed[id] >= 0 &&
        effects.healed[id] <= 2,
    );
    const value = unit.hp + effects.healed[id];
    assert.ok(value <= rules.units[unit.unitType - 1].maxHp);
    assert.ok(
      unit.alive || effects.healed[id] === 0,
      `${entry.name}: no resurrection`,
    );
    return value;
  });
  assert.deepEqual(stages.Support.hp, hp);
  assert.deepEqual(stages.Support.healed, effects.healed);
  const shields = state.units.map((unit, id) =>
    unit.alive &&
    unit.unitType === 1 &&
    actions[Math.floor(id / 3)][id % 3].actionType === 3
      ? rules.units[0].skill.totalDamageReduction
      : 0,
  );
  assert.deepEqual(stages.Support.shield, shields);
  const map = maps.find((value) => value.mapId === state.mapId);
  for (let id = 0; id < 6; id++) {
    if (!map.cover.includes(positions[id]))
      assert.equal(effects.coverReduced[id], 0);
    const raw = stages.Damage.rawDamage[id],
      cover = effects.coverReduced[id],
      shield = effects.shieldReduced[id];
    assert.ok(Number.isInteger(raw) && raw >= cover && cover >= 0);
    assert.equal(shield, Math.min(shields[id], raw - cover));
    assert.equal(
      effects.damageTaken[id],
      Math.min(hp[id], raw - cover - shield),
      `${entry.name}: damage after healing/Cover/shield`,
    );
    assert.ok(
      effects.lockedRoundApplied[id] === 0 ||
        effects.lockedRoundApplied[id] === round + 1,
    );
  }
  const afterDamage = hp.map((value, id) => value - effects.damageTaken[id]);
  assert.deepEqual(stages.Damage.hp, afterDamage);
  for (const field of ["coverReduced", "shieldReduced", "damageTaken"])
    assert.deepEqual(stages.Damage[field], effects[field]);
  assert.deepEqual(
    stages.Status.lockedRoundApplied,
    effects.lockedRoundApplied,
  );
  const units = state.units.map((unit, id) => ({
    ...unit,
    hp: afterDamage[id],
    position: afterDamage[id] === 0 ? 255 : positions[id],
    alive: afterDamage[id] > 0,
    lockedRound: afterDamage[id] === 0 ? 0 : effects.lockedRoundApplied[id],
  }));
  assert.deepEqual(
    next.units,
    units,
    `${entry.name}: canonical deaths and lock lifetime`,
  );
  const energy = state.energy.map((value, side) => {
    const income = units
      .slice(side * 3, side * 3 + 3)
      .filter(
        (unit) => unit.alive && map.resources.includes(unit.position),
      ).length;
    const result = Math.min(
      rules.match.maxEnergy,
      value - spent[side] + income,
    );
    assert.equal(effects.energyGained[side], result - (value - spent[side]));
    return result;
  });
  const central = [0, 1].map(
    (side) =>
      units
        .slice(side * 3, side * 3 + 3)
        .filter((unit) => unit.alive && map.controlZone.includes(unit.position))
        .length,
  );
  const vp = state.victoryPoints.map((value, side) => {
    const gained =
      central[side] > central[1 - side] ? rules.match.controlAward : 0;
    assert.equal(effects.victoryPointsGained[side], gained);
    return value + gained;
  });
  assert.deepEqual(next.energy, energy);
  assert.deepEqual(next.victoryPoints, vp);
  for (const field of ["units", "energy", "victoryPoints"])
    assert.deepEqual(stages.WorldUpdate[field], next[field]);
  for (const field of ["energyGained", "victoryPointsGained"])
    assert.deepEqual(stages.WorldUpdate[field], effects[field]);
  assert.equal(next.mapId, state.mapId);
  assert.equal(next.battleStarted, true);
  assert.equal(next.completedRound, round);
  const hpTotals = [0, 1].map((side) =>
    units.slice(side * 3, side * 3 + 3).reduce((sum, unit) => sum + unit.hp, 0),
  );
  let outcome = 0,
    reason = 0;
  if (!hpTotals[0] || !hpTotals[1]) {
    outcome = hpTotals[0] ? 1 : hpTotals[1] ? 2 : 3;
    reason = hpTotals[0] || hpTotals[1] ? 1 : 2;
  } else if (
    Math.max(...vp) >= rules.match.victoryThreshold ||
    round === rules.match.maxRounds
  ) {
    reason = Math.max(...vp) >= rules.match.victoryThreshold ? 3 : 4;
    const difference = vp[0] - vp[1] || hpTotals[0] - hpTotals[1];
    outcome = difference > 0 ? 1 : difference < 0 ? 2 : 3;
  }
  assert.deepEqual(
    [next.outcome, next.reason],
    [outcome, reason],
    `${entry.name}: outcome priority`,
  );
  assert.deepEqual(stages.Finalize, {
    completedRound: round,
    activeRound: outcome ? round : round + 1,
    outcome,
    reason,
  });
}

export async function prepareSquadBaseline(root, rules, maps, protocol) {
  const manifest = await readJson(new URL("config/squad-baseline.json", root));
  const vectors = await readJson(
    new URL("config/squad-battle-vectors.json", root),
  );
  const original = await readJson(new URL("config/state-vectors.json", root));
  assert.equal(manifest.status, "design-baseline-frozen");
  assert.equal(vectors.status, "reference-frozen");
  assert.equal(vectors.resolverExecution, "pending-implementation");
  assert.equal(vectors.rulesetId, protocol.rulesetId);
  assert.deepEqual(manifest.profiles, [
    {
      rulesetId: original.rulesHash,
      schemas: [1, 1, 1],
      abi: "fixed-arena",
      engine: "fixed",
      replay: true,
    },
    {
      rulesetId: protocol.rulesetId,
      schemas: [2, 2, 2],
      abi: "squad-arena",
      engine: "squad",
      replay: false,
    },
  ]);
  for (const entry of manifest.selections)
    assert.ok(
      ["codec", "replay"].includes(entry.capability),
      "Unknown selection capability",
    );
  assert.deepEqual(
    manifest.reviews.map((row) => row.topic),
    [
      "rules",
      "maps",
      "squad",
      "settlement",
      "data-model",
      "encoding",
      "hash",
      "events",
      "AI-policy",
      "testing",
    ],
  );
  for (const row of manifest.reviews) {
    assert.equal(row.status, "frozen-for-implementation");
    assert.ok(
      !row.source.startsWith("docs/") &&
        (!row.source.endsWith(".md") || row.source === "README.md"),
    );
    await access(new URL(row.source, root));
  }
  assert.deepEqual(manifest.compatibility.globalIdentity, [
    "chainId",
    "arena",
    "matchId",
  ]);
  assert.deepEqual(manifest.compatibility.localIdentity, [
    "chainId",
    "arena",
    "deploymentHash",
    "matchId",
  ]);
  assert.deepEqual(manifest.ai.order, [
    "select-AI-bundle-from-public-state",
    "persist-AI-bundle-policy-and-seed",
    "accept-player-current-bundle",
    "resolve-both-bundles",
  ]);
  assert.equal(manifest.ai.mode, "off-chain-practice-only");
  assert.equal(manifest.ai.runtime, "pending-practice-implementation");
  assert.deepEqual(manifest.ai.difficulties, ["Easy", "Normal", "Hard"]);
  assert.equal(
    manifest.api.implementation,
    "pending-indexing-and-client-integration",
  );
  assert.deepEqual(manifest.api.verificationStatuses, [
    "Verified",
    "Mismatch",
    "Incomplete",
  ]);
  assert.deepEqual(manifest.api.confirmationStatuses, [
    "unknown",
    "observed",
    "provisional",
    "confirmed",
  ]);
  assert.deepEqual(manifest.api.meta, [
    "chainId",
    "arena",
    "deploymentHash",
    "deploymentBlock",
    "rulesetId",
    "actionSchema",
    "stateSchema",
    "eventSchema",
  ]);
  for (const field of [
    "activeRound",
    "completedRound",
    "source",
    "confirmation",
  ])
    assert.ok(manifest.api.match.includes(field));
  const blockers = manifest.decisions.filter(
    (row) => row.classification === "implementation-blocking",
  );
  assert.equal(blockers.length, 3);
  assert.ok(
    blockers.every((row) => row.status === "closed"),
    "An implementation-blocking decision remains open",
  );
  assert.ok(
    manifest.decisions
      .filter((row) => row.classification !== "implementation-blocking")
      .every((row) => row.status === "unmeasured"),
  );
  const output = [],
    keys = new Set(),
    combinations = new Set();
  function stateCase(name, state, expectedHash) {
    output.push({
      name,
      kind: 4,
      valid: true,
      input: { context: vectors.context, rulesetId: vectors.rulesetId, state },
      expectedHash,
    });
  }
  const permutations = [];
  for (let a = 1; a <= 5; a++)
    for (let b = 1; b <= 5; b++)
      for (let c = 1; c <= 5; c++)
        if (new Set([a, b, c]).size === 3) permutations.push([a, b, c]);
  assert.equal(vectors.initializations.length, 360);
  for (const row of vectors.initializations) {
    const key = `${row.mapId}:${row.side}:${row.squad.join(",")}`;
    assert.ok(!keys.has(key));
    keys.add(key);
    assert.deepEqual(row.opponent, [1, 2, 3]);
    assert.ok(row.side === 0 || row.side === 1);
    combinations.add([...row.squad].sort().join(","));
    stateCase(row.name, initialState(row, rules, maps), row.stateHash);
  }
  for (const map of maps)
    for (const side of [0, 1])
      for (const types of permutations)
        assert.ok(
          keys.has(`${map.mapId}:${side}:${types.join(",")}`),
          "Map/side/ordered-squad case missing",
        );
  assert.equal(combinations.size, 10);
  assert.deepEqual(manifest.coverage.initialization, {
    maps: 3,
    orderedSquads: 60,
    combinations: 10,
    sides: 2,
    rows: 360,
    opponent: [1, 2, 3],
    scope:
      "every ordered lineup on both sides of every map against the fixed reference lineup; not all 3600 lineup pairs",
  });
  for (const family of [vectors.rounds, vectors.rejections]) {
    const names = new Set(family.map((entry) => entry.name));
    assert.equal(names.size, family.length, "Unique reference names");
    for (const entry of family)
      if (!entry.name.startsWith("swapped:"))
        assert.ok(
          names.has(`swapped:${entry.name}`),
          `Missing exchanged-side reference: ${entry.name}`,
        );
  }
  const tags = new Set();
  for (const entry of [...vectors.rounds, ...vectors.rejections]) {
    entry.tags.forEach((tag) => tags.add(tag));
    assert.deepEqual(entry.input.context, vectors.context);
    assert.equal(entry.input.rulesetId, vectors.rulesetId);
    stateCase(
      `${entry.name}:before`,
      entry.input.state,
      entry.expected.beforeStateHash ?? entry.expected.stateHash,
    );
    for (let side = 0; side < 2; side++) {
      const units = entry.input.state.units.slice(side * 3, side * 3 + 3);
      output.push({
        name: `${entry.name}:actions:${side}`,
        kind: 3,
        valid: true,
        input: {
          context: entry.input.context,
          player: entry.input.players[side],
          rulesetId: vectors.rulesetId,
          unitTypes: units.map((unit) => unit.unitType),
          salt: entry.input.salts[side],
          round: entry.input.round,
          side,
          alive: units.map((unit) => unit.alive),
          lockedRound: units.map((unit) => unit.lockedRound),
          actions: entry.input.actions[side],
        },
        expectedHash:
          entry.expected.commitments?.[side] ?? entry.commitments[side],
      });
    }
    if (vectors.rejections.includes(entry)) {
      assert.equal(entry.expected.rejectAt, "Validate");
      assert.deepEqual(entry.expected.state, entry.input.state);
      assert.deepEqual(entry.expected.effects, emptyEffects());
      continue;
    }
    try {
      checkRound(entry, rules, maps);
    } catch (error) {
      error.message = `${entry.name}: ${error.message}`;
      throw error;
    }
    stateCase(
      `${entry.name}:after`,
      entry.expected.state,
      entry.expected.stateHash,
    );
    output.push({
      name: `${entry.name}:resolved-event`,
      kind: 5,
      valid: true,
      input: {
        eventType: 8,
        matchId: vectors.context.matchId,
        round: entry.input.round,
        player: entry.input.players[0],
        rulesetId: vectors.rulesetId,
        mapId: entry.input.state.mapId,
        mapHash: maps.find((map) => map.mapId === entry.input.state.mapId)
          .mapHash,
        deadline: 0,
        commitment: entry.expected.commitments[0],
        unitTypes: entry.input.state.units
          .slice(0, 3)
          .map((unit) => unit.unitType),
        salt: entry.input.salts[0],
        state: entry.expected.state,
        actions: entry.input.actions[0],
        fromPhase: 6,
        toPhase: entry.expected.state.outcome ? 7 : 4,
        beforeHash: entry.expected.beforeStateHash,
        afterHash: entry.expected.stateHash,
        effects: entry.expected.effects,
        winner: "0x0000000000000000000000000000000000000000",
      },
      expectedEncoding: entry.expected.event.encoding,
      expectedTopics: entry.expected.event.topics,
    });
  }
  for (const tag of manifest.coverage.requiredTags)
    assert.ok(tags.has(tag), `No concrete case for ${tag}`);
  const altered = structuredClone(
    vectors.rounds.find((row) => row.name === "heal-injured"),
  );
  altered.expected.effects.healed[0]++;
  assert.throws(
    () => checkRound(altered, rules, maps),
    assert.AssertionError,
    "Changed full-state reference must fail",
  );
  assert.ok(vectors.rounds.some((row) => row.name === "Scout-four-step-Dash"));
  return {
    cases: output,
    manifest,
    report: {
      scope:
        "frozen full-state references, coverage, codec agreement and metadata selection; resolver execution is pending",
      initializations: keys.size,
      maps: maps.length,
      orderedSquads: permutations.length,
      combinations: combinations.size,
      sides: 2,
      rounds: vectors.rounds.length,
      rejectionReferences: vectors.rejections.length,
      codecCases: output.length,
      reviewTopics: manifest.reviews.length,
      closedImplementationDecisions: blockers.length,
      measurementDecisions: manifest.decisions
        .filter((row) => row.classification !== "implementation-blocking")
        .map((row) => row.topic),
      resolverExecution: vectors.resolverExecution,
      alteredReferenceRejected: true,
    },
  };
}
