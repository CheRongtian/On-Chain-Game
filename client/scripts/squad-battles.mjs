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

export function prepareSquadBattles(config, baseline, viem) {
  const inputType = viem.parseAbiParameters(
    `(${config.types.state} state,${config.types.action}[3][2] actions)`,
  );
  const outputType = viem.parseAbiParameters(
    `${config.types.state} next,${config.types.effects} effects,${traceType} trace,${config.types.state} initial,${config.types.action}[3][2] actions`,
  );
  const cases = [];
  function add(row, kind, label, valid, exchange = false) {
    const state = exchange ? exchangeState(row.input.state) : row.input.state;
    const actions = exchange
      ? exchanged(row.input.actions).map((bundle) =>
          bundle.map((action) => ({
            ...action,
            targetUnit: action.targetUnit < 6 ? (action.targetUnit + 3) % 6 : action.targetUnit,
          })),
        )
      : row.input.actions;
    const expected = valid
      ? {
          state: exchange ? exchangeState(row.expected.state) : row.expected.state,
          effects: exchange ? exchangeEffects(row.expected.effects) : row.expected.effects,
          stages: exchange ? exchangeStages(row.expected.stages) : row.expected.stages,
        }
      : undefined;
    cases.push({
      name: `${label}:${row.name}`,
      kind,
      payload: viem.encodeAbiParameters(inputType, [{ state, actions }]),
      state,
      actions,
      valid,
      expected,
    });
  }
  for (const row of baseline.references.rounds) {
    add(row, 0, 'reference', true);
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
  assert.equal(new Set(cases.map((row) => row.name)).size, cases.length);

  function compare(entry, result, selector) {
    assert.equal(result.accepted, entry.valid, `${entry.name}: resolver acceptance`);
    if (!entry.valid) {
      assert.equal(
        result.rejection,
        selector,
        `${entry.name}: explicit protocol rejection, no panic`,
      );
      return;
    }
    const [next, effects, trace, initial, actions] = viem.decodeAbiParameters(
      outputType,
      result.encoding,
    );
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
    compareValue(stages, entry.expected.stages, `${entry.name}.stages`);
    compareValue(next, entry.expected.state, `${entry.name}.state`);
    compareValue(effects, entry.expected.effects, `${entry.name}.effects`);
    return { name: entry.name, stages, state: next, effects };
  }

  return {
    cases,
    compare,
    report: {
      scope:
        'actual pure Solidity seven-stage resolution, fixed state/effect checkpoints, order and ownership comparisons; no phase transactions, new hash implementation or Go resolver',
      cases: cases.length,
      accepted: cases.filter((row) => row.valid).length,
      rejected: cases.filter((row) => !row.valid).length,
      frozenRounds: baseline.references.rounds.length,
      frozenRejections: baseline.references.rejections.length,
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
