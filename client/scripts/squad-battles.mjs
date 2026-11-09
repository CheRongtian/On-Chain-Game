import assert from 'node:assert/strict';

const traceType =
  '(uint8[6] positions,uint8[6] supportHp,uint8[6] shields,uint8[6] rawDamage,uint8[6] damageHp,uint16 activeRound)';

function exchanged(values) {
  return values.length === 2 ? [values[1], values[0]] : [...values.slice(3), ...values.slice(0, 3)];
}

function exchangeState(state) {
  return {
    ...state,
    units: exchanged(state.units),
    energy: exchanged(state.energy),
    victoryPoints: exchanged(state.victoryPoints),
    outcome: state.outcome === 1 ? 2 : state.outcome === 2 ? 1 : state.outcome,
  };
}

function exchangeEffects(effects) {
  return Object.fromEntries(
    Object.entries(effects).map(([key, values]) => [key, exchanged(values)]),
  );
}

function exchangeActions(actions) {
  return exchanged(actions).map((bundle) =>
    bundle.map((action) => ({
      ...action,
      targetUnit: action.targetUnit < 6 ? (action.targetUnit + 3) % 6 : action.targetUnit,
    })),
  );
}

function exchangeStages(stages) {
  return Object.fromEntries(
    Object.entries(stages).map(([stage, values]) => [
      stage,
      stage === 'Finalize'
        ? {
            ...values,
            outcome: values.outcome === 1 ? 2 : values.outcome === 2 ? 1 : values.outcome,
          }
        : Object.fromEntries(Object.entries(values).map(([key, list]) => [key, exchanged(list)])),
    ]),
  );
}

function compareValue(actual, expected, field) {
  if (expected !== null && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual), Object.keys(expected), `${field}: field layout`);
    for (const key of Object.keys(expected))
      compareValue(actual[key], expected[key], `${field}.${key}`);
  } else if (actual !== expected) {
    const error = new Error(`${field}: expected ${expected}, got ${actual}`);
    error.difference = { field, expected, actual };
    throw error;
  }
}

export function prepareSquadBattles(config, baseline, viem, edges) {
  assert.equal(edges.status, 'frozen-skill-and-lifecycle-references');
  assert.equal(edges.rounds.length, 33, 'Supplemental round matrix');
  assert.equal(edges.sequences.length, 9, 'Continuous lifecycle matrix');
  for (const mapId of [1, 2, 3]) {
    assert.equal(
      edges.rounds.filter((row) => row.input.state.mapId === mapId).length,
      11,
      `Map ${mapId}: skill/result boundaries`,
    );
    assert.deepEqual(
      edges.sequences
        .filter((row) => row.state.mapId === mapId)
        .map((row) => row.name)
        .sort(),
      [
        `lock-expiration:map-${mapId}`,
        `lock-renewal:map-${mapId}`,
        `death-clears-lock-and-denies-skill:map-${mapId}`,
      ].sort(),
      `Map ${mapId}: complete lifecycle families`,
    );
  }
  const inputType = viem.parseAbiParameters(
    `(${config.types.context} context,${config.types.state} state,${config.types.action}[3][2] actions)`,
  );
  const outputType = viem.parseAbiParameters(
    `(${config.types.state} next,${config.types.effects} effects,${traceType} trace,${config.types.state} initial,${config.types.action}[3][2] actions,bytes beforeEncoding,bytes afterEncoding,bytes32 beforeHash,bytes32 stateHash,uint256 resolveGas,uint256 hashGas)`,
  );
  const sequenceType = viem.parseAbiParameters(
    `(${config.types.context} context,${config.types.state} state,${config.types.action}[3][2][] steps)`,
  );
  const sequenceOutput = viem.parseAbiParameters(
    `(bool accepted,bytes result)[],${config.types.state},${config.types.state}`,
  );
  const contextValue = (context) => ({
    ...context,
    chainId: BigInt(context.chainId),
    matchId: BigInt(context.matchId),
  });
  const cases = [];
  function add(row, kind, label, valid, exchange = false) {
    const state = exchange ? exchangeState(row.input.state) : row.input.state;
    const actions = exchange ? exchangeActions(row.input.actions) : row.input.actions;
    const context = row.input.context;
    const expected = valid
      ? {
          state: exchange ? exchangeState(row.expected.state) : row.expected.state,
          effects: exchange ? exchangeEffects(row.expected.effects) : row.expected.effects,
          stages:
            exchange && row.expected.stages
              ? exchangeStages(row.expected.stages)
              : row.expected.stages,
          beforeStateHash: exchange ? undefined : row.expected.beforeStateHash,
          stateHash: exchange ? undefined : row.expected.stateHash,
        }
      : undefined;
    cases.push({
      name: `${label}:${row.name}`,
      kind,
      payload: viem.encodeAbiParameters(inputType, [
        { context: contextValue(context), state, actions },
      ]),
      context,
      state,
      actions,
      valid,
      expected,
      measurement: !row.comparisonOnly,
    });
  }
  for (const row of [...baseline.references.rounds, ...edges.rounds]) {
    add(row, 0, baseline.references.rounds.includes(row) ? 'reference' : 'edge', true);
    add(row, 1, 'B-first', true);
    add(row, 0, 'ownership-swap', true, true);
    if (row.expected.state.outcome) {
      add(
        { ...row, input: { ...row.input, state: row.expected.state } },
        0,
        'finished-rejects-settlement',
        false,
      );
    }
  }
  for (const row of baseline.references.rejections) {
    add(row, 0, 'rejection', false);
    add(row, 1, 'rejection-B-first', false);
    add(row, 0, 'rejection-ownership-swap', false, true);
  }
  for (const row of edges.sequences)
    for (const exchange of [false, true]) {
      const state = exchange ? exchangeState(row.state) : row.state;
      const steps = row.steps.map((step) => ({
        ...step,
        actions: exchange ? exchangeActions(step.actions) : step.actions,
        expected: {
          state: exchange ? exchangeState(step.expected.state) : step.expected.state,
          effects: exchange ? exchangeEffects(step.expected.effects) : step.expected.effects,
          beforeStateHash: exchange ? undefined : step.expected.beforeStateHash,
          stateHash: exchange ? undefined : step.expected.stateHash,
        },
      }));
      cases.push({
        name: `${exchange ? 'ownership-swap:' : ''}sequence:${row.name}`,
        kind: 2,
        valid: true,
        payload: viem.encodeAbiParameters(sequenceType, [
          { context: contextValue(row.context), state, steps: steps.map((step) => step.actions) },
        ]),
        sequence: { context: row.context, state, steps },
      });
    }
  for (const mapId of [1, 2, 3]) {
    const row = baseline.references.rounds[0];
    const state = { ...row.input.state, mapId };
    cases.push({
      name: `protocol-fields-excluded:map-${mapId}`,
      kind: 3,
      valid: true,
      protocolIsolation: true,
      payload: viem.encodeAbiParameters(inputType, [
        { context: contextValue(row.input.context), state, actions: row.input.actions },
      ]),
    });
  }
  assert.equal(new Set(cases.map((row) => row.name)).size, cases.length);

  function compare(entry, result, selector) {
    assert.equal(
      result.accepted,
      entry.valid,
      `${entry.name}: resolver acceptance (${result.rejection ?? 'accepted'})`,
    );
    if (!entry.valid) {
      assert.equal(
        result.rejection,
        selector,
        `${entry.name}: explicit protocol rejection, no panic`,
      );
      return;
    }
    if (entry.sequence) {
      const [results, finalState, initial] = viem.decodeAbiParameters(
        sequenceOutput,
        result.encoding,
      );
      assert.equal(results.length, entry.sequence.steps.length, `${entry.name}: sequence length`);
      compareValue(initial, entry.sequence.state, `${entry.name}.input.state`);
      let current = entry.sequence.state;
      const steps = [];
      for (const [index, step] of entry.sequence.steps.entries()) {
        const name = `${entry.name}:step-${index + 1}`;
        const actual = results[index];
        const output = compare(
          {
            name,
            valid: step.accepted,
            context: entry.sequence.context,
            state: current,
            actions: step.actions,
            expected: step.expected,
          },
          actual.accepted
            ? { accepted: true, encoding: actual.result }
            : { accepted: false, rejection: actual.result },
          selector,
        );
        if (actual.accepted) current = step.expected.state;
        else compareValue(current, step.expected.state, `${name}.unchanged-state`);
        steps.push(output ?? { name, accepted: false, rejection: actual.result });
      }
      compareValue(finalState, current, `${entry.name}.final-state`);
      return { name: entry.name, steps, finalState };
    }
    if (entry.protocolIsolation) {
      const [before, after] = viem.decodeAbiParameters(
        viem.parseAbiParameters('bytes32,bytes32'),
        result.encoding,
      );
      assert.equal(before, after, `${entry.name}: protocol metadata cannot change battle hash`);
      return { name: entry.name, hash: before, protocolIsolation: true };
    }
    const [
      {
        next,
        effects,
        trace,
        initial,
        actions,
        beforeEncoding,
        afterEncoding,
        beforeHash,
        stateHash,
        resolveGas,
        hashGas,
      },
    ] = viem.decodeAbiParameters(outputType, result.encoding);
    compareValue(initial, entry.state, `${entry.name}.input.state`);
    compareValue(actions, entry.actions, `${entry.name}.input.actions`);
    const stages = {
      Validate: { energySpent: effects.energySpent },
      Movement: { positions: trace.positions },
      Support: { hp: trace.supportHp, healed: effects.healed, shield: trace.shields },
      Damage: {
        rawDamage: trace.rawDamage,
        coverReduced: effects.coverReduced,
        shieldReduced: effects.shieldReduced,
        damageTaken: effects.damageTaken,
        hp: trace.damageHp,
      },
      Status: { lockedRoundApplied: effects.lockedRoundApplied },
      WorldUpdate: {
        units: next.units,
        energy: next.energy,
        victoryPoints: next.victoryPoints,
        energyGained: effects.energyGained,
        victoryPointsGained: effects.victoryPointsGained,
      },
      Finalize: {
        completedRound: next.completedRound,
        activeRound: trace.activeRound,
        outcome: next.outcome,
        reason: next.reason,
      },
    };
    if (entry.expected.stages) compareValue(stages, entry.expected.stages, `${entry.name}.stages`);
    compareValue(next, entry.expected.state, `${entry.name}.state`);
    compareValue(effects, entry.expected.effects, `${entry.name}.effects`);
    if (entry.expected.beforeStateHash)
      assert.equal(
        beforeHash,
        entry.expected.beforeStateHash,
        `${entry.name}: frozen before-state hash`,
      );
    if (entry.expected.stateHash)
      assert.equal(
        stateHash,
        entry.expected.stateHash,
        `${entry.name}: frozen resolved-state hash`,
      );
    return {
      name: entry.name,
      context: entry.context,
      stages,
      state: next,
      effects,
      initial,
      beforeEncoding,
      afterEncoding,
      beforeHash,
      stateHash,
      gas: { resolve: Number(resolveGas), hash: Number(hashGas) },
      measurement: entry.measurement !== false,
    };
  }

  return {
    cases,
    compare,
    report: {
      scope:
        'actual pure Solidity resolution, fixed state/effect/hash references, skill edges and continuous lock/death sequences; no phase transactions or Go resolver',
      cases: cases.length,
      accepted: cases.filter((row) => row.valid).length,
      rejected: cases.filter((row) => !row.valid).length,
      frozenRounds: baseline.references.rounds.length,
      frozenRejections: baseline.references.rejections.length,
      skillEdgeRounds: edges.rounds.length,
      continuousSequences: edges.sequences.length * 2,
      continuousRejections:
        edges.sequences.reduce(
          (sum, row) => sum + row.steps.filter((step) => !step.accepted).length,
          0,
        ) * 2,
      protocolIsolation: 3,
      stageOrder: [
        'Validate',
        'Movement',
        'Support',
        'Damage',
        'Status',
        'WorldUpdate',
        'Finalize',
      ],
      results: [],
    },
  };
}
