import assert from 'node:assert/strict';

export function prepareSquadActions(config, rules, maps, baseline, viem) {
  const { encodeAbiParameters: encode, parseAbiParameters: parse } = viem;
  const cases = [];
  const input = parse(`(${config.types.state} state,uint8 side,${config.types.action}[3] actions)`);
  const output = parse(`uint8,${config.types.state},${config.types.action}[3]`);
  const hold = () => ({
    actionType: 0,
    targetCell: 255,
    targetUnit: 255,
    pathLength: 0,
    pathBits: 0,
  });
  const bundle = () => [hold(), hold(), hold()];
  const move = (cells, skill = false) => ({
    ...hold(),
    actionType: skill ? 3 : 1,
    pathLength: cells.length,
    pathBits: cells.reduce((bits, cell, index) => bits + cell * 2 ** (6 * index), 0),
  });
  const attack = (cell, skill = false) => ({
    ...hold(),
    actionType: skill ? 3 : 2,
    targetCell: cell,
  });
  const heal = (targetUnit) => ({ ...hold(), actionType: 3, targetUnit });
  function add(name, kind, payload, expectedEncoding, group) {
    cases.push({
      name,
      kind,
      payload,
      expectedEncoding,
      valid: expectedEncoding !== undefined,
      group,
    });
  }
  const rotate = (cell) => (cell === 255 ? 255 : 63 - cell);
  function swappedState(state) {
    return {
      ...structuredClone(state),
      units: [...state.units.slice(3), ...state.units.slice(0, 3)].map((unit) => ({
        ...unit,
        position: rotate(unit.position),
      })),
      energy: [...state.energy].reverse(),
      victoryPoints: [...state.victoryPoints].reverse(),
      outcome: state.outcome === 1 ? 2 : state.outcome === 2 ? 1 : state.outcome,
    };
  }
  function swappedActions(actions) {
    return actions.map((action) => ({
      ...action,
      targetCell: rotate(action.targetCell),
      targetUnit: action.targetUnit < 6 ? (action.targetUnit + 3) % 6 : action.targetUnit,
      pathBits: Array.from({ length: action.pathLength }, (_, step) =>
        rotate(Number((BigInt(action.pathBits) >> BigInt(6 * step)) & 63n)),
      ).reduce((bits, cell, step) => bits + cell * 2 ** (6 * step), 0),
    }));
  }
  function addBundle(name, state, actions, valid, cost, group, side = 0, mirror = true) {
    add(
      name,
      0,
      encode(input, [{ state, side, actions }]),
      valid ? encode(output, [cost, state, actions]) : undefined,
      group,
    );
    if (mirror)
      addBundle(
        `swapped:${name}`,
        swappedState(state),
        swappedActions(actions),
        valid,
        cost,
        group,
        1 - side,
        false,
      );
  }
  const references = baseline.references;
  for (const row of references.rounds)
    for (const side of [0, 1])
      addBundle(
        `reference:${row.name}:${side}`,
        row.input.state,
        row.input.actions[side],
        true,
        row.expected.effects.energySpent[side],
        'reference-legal',
        side,
        false,
      );
  for (const row of references.rejections)
    for (const side of [0, 1]) {
      const invalidSide = row.name.startsWith('swapped:') ? 1 : 0;
      addBundle(
        `reference:${row.name}:${side}`,
        row.input.state,
        row.input.actions[side],
        side !== invalidSide,
        0,
        'reference-rejection',
        side,
        false,
      );
    }
  function board(map, types = [1, 4, 5, 1, 2, 3], positions = [0]) {
    const used = new Set(positions.filter((value) => value !== undefined));
    const cells = [...positions];
    for (let id = 0; id < 6; id++)
      if (cells[id] === undefined) {
        const free = Array.from({ length: 64 }, (_, index) => 63 - index).find(
          (cell) => !map.obstacles.includes(cell) && !used.has(cell),
        );
        assert.notEqual(free, undefined);
        cells[id] = free;
        used.add(free);
      }
    assert.equal(new Set(cells).size, 6);
    assert.ok(cells.every((cell) => !map.obstacles.includes(cell)));
    return {
      mapId: map.mapId,
      battleStarted: true,
      completedRound: 3,
      units: types.map((unitType, id) => ({
        unitType,
        position: cells[id],
        hp: rules.units[unitType - 1].maxHp,
        alive: true,
        lockedRound: 0,
      })),
      energy: [5, 5],
      victoryPoints: [0, 0],
      outcome: 0,
      reason: 0,
    };
  }
  for (const map of maps) {
    for (let cell = 0; cell < 64; cell++)
      add(
        `terrain:${map.mapId}:${cell}`,
        1,
        encode(parse('uint8,uint8'), [map.mapId, cell]),
        encode(parse('uint8,uint8,uint8,bool,bool,bool,bool,bool,bool'), [
          cell % 8,
          Math.floor(cell / 8),
          cell,
          map.obstacles.includes(cell),
          map.cover.includes(cell),
          map.resources.includes(cell),
          map.controlZone.includes(cell),
          map.spawns.A.includes(cell),
          map.spawns.B.includes(cell),
        ]),
        'terrain',
      );
    for (const cell of [64, 255])
      add(
        `terrain:invalid-cell:${map.mapId}:${cell}`,
        1,
        encode(parse('uint8,uint8'), [map.mapId, cell]),
        undefined,
        'terrain-boundary',
      );
    const test = (name, state, actions, valid, cost = 0, group = 'geometry', mirror = true) =>
      addBundle(`${name}:map-${map.mapId}`, state, actions, valid, cost, group, 0, mirror);
    const one = (action) => [action, hold(), hold()];
    const base = board(map);
    test('origin-revisit', board(map, [3, 4, 5, 1, 2, 3]), one(move([1, 0])), false);
    test('repeated-path-cell', board(map, [3, 4, 5, 1, 2, 3]), one(move([1, 2, 1])), false);
    test('diagonal-first-step', base, one(move([9])), false);
    test('row-wrap', board(map, undefined, [7]), one(move([8])), false);
    test('Guardian-too-many-steps', base, one(move([1, 2])), false);
    test('four-step-Dash', board(map, [3, 4, 5, 1, 2, 3]), one(move([1, 2, 3, 4], true)), true, 1);
    test('five-step-Dash', board(map, [3, 4, 5, 1, 2, 3]), one(move([1, 2, 3, 4, 5], true)), false);
    const occupied = board(map, undefined, [0, 1, 4]);
    test('friendly-origin-stays-blocked', occupied, [move([1]), move([2]), hold()], false);
    test('enemy-origin-stays-blocked', board(map, undefined, [0, 5, 6, 1]), one(move([1])), false);
    const cleared = structuredClone(occupied);
    cleared.units[1] = { ...cleared.units[1], hp: 0, alive: false, position: 255 };
    test('canonical-death-frees-cell', cleared, one(move([1])), true);
    const wall = map.obstacles.find(
      (cell) =>
        cell % 8 > 0 &&
        cell % 8 < 7 &&
        !map.obstacles.includes(cell - 1) &&
        !map.obstacles.includes(cell + 1),
    );
    assert.notEqual(wall, undefined);
    const rayCases = [
      [0, 3, 3, true],
      [0, 4, 3, false],
      [0, 0, 3, false],
      [0, 9, 3, false],
      [63, 60, 3, true],
      [7, 8, 3, false],
      [0, 24, 3, true],
      [0, 1, 0, false],
      [64, 0, 3, false],
      [0, 64, 3, false],
      [0, 255, 3, false],
      [255, 0, 3, false],
      [wall - 1, wall + 1, 3, false],
      [wall - 1, wall, 3, false],
      [wall, wall + 1, 3, false],
    ];
    const coverRay = map.cover
      .flatMap((cell) => [1, 8].map((stride) => [cell - stride, cell + stride]))
      .find(
        ([from, to]) =>
          from >= 0 &&
          to < 64 &&
          !map.obstacles.includes(from) &&
          !map.obstacles.includes(to) &&
          (Math.floor(from / 8) === Math.floor(to / 8) || from % 8 === to % 8),
      );
    assert.ok(coverRay);
    rayCases.push([...coverRay, 2, true]);
    rayCases.forEach(([from, to, range, expected], index) =>
      add(
        `ray:${map.mapId}:${index}`,
        3,
        encode(parse('uint8,uint8,uint8,uint8'), [map.mapId, from, to, range]),
        encode(parse('bool'), [expected]),
        'rays',
      ),
    );
    test('wall-path', board(map, undefined, [wall - 1]), one(move([wall])), false);
    const ranger = board(map, [2, 4, 5, 1, 2, 3]);
    test('Ranger-range-three', ranger, one(attack(3)), true);
    test('Ranger-Power-shot', ranger, one(attack(3, true)), true, 2);
    test('Ranger-range-four', ranger, one(attack(4)), false);
    test('Ranger-self-cell', ranger, one(attack(0)), false);
    test('Ranger-diagonal', ranger, one(attack(9)), false);
    const rayBoard = board(map, [2, 4, 5, 1, 2, 3], [wall - 1]);
    test('wall-at-ray-target', rayBoard, one(attack(wall)), false);
    test('wall-inside-ray', rayBoard, one(attack(wall + 1)), false);
    test(
      'units-do-not-block-rays',
      board(map, [2, 4, 5, 1, 2, 3], [0, 1, 4, 2]),
      one(attack(2)),
      true,
    );
    test('empty-attack-cell', ranger, one(attack(2)), true);
    test('friendly-attack-cell', board(map, [2, 4, 5, 1, 2, 3], [0, 1]), one(attack(1)), true);
    const saboteur = board(map, [5, 4, 1, 1, 2, 3]);
    test('lock-range-two-empty', saboteur, one(attack(2, true)), true, 2, 'skills');
    test(
      'lock-friendly-cell',
      board(map, [5, 4, 1, 1, 2, 3], [0, 1]),
      one(attack(1, true)),
      true,
      2,
      'skills',
    );
    test(
      'lock-units-do-not-block',
      board(map, [5, 4, 1, 1, 2, 3], [0, 1, 4, 2]),
      one(attack(2, true)),
      true,
      2,
      'skills',
    );
    for (const target of [0, 3, 9])
      test(
        `invalid-lock-target-${target}`,
        saboteur,
        one(attack(target, true)),
        false,
        0,
        'skills',
      );
    test(
      'wall-blocks-lock',
      board(map, [5, 4, 1, 1, 2, 3], [wall - 1]),
      one(attack(wall + 1, true)),
      false,
      0,
      'skills',
    );
    const medic = board(map, [4, 1, 5, 1, 2, 3]);
    test('self-heal-full-HP', medic, one(heal(0)), true, 2, 'skills');
    test('far-friendly-heal-is-dynamic', medic, one(heal(1)), true, 2, 'skills');
    test(
      'walls-do-not-block-healing',
      board(map, [4, 1, 5, 1, 2, 3], [wall - 1, wall + 1]),
      one(heal(1)),
      true,
      2,
      'skills',
    );
    test('enemy-heal', medic, one(heal(3)), false, 0, 'skills');
    const deadTarget = structuredClone(medic);
    deadTarget.units[1] = { ...deadTarget.units[1], hp: 0, alive: false, position: 255 };
    test('dead-heal-target', deadTarget, one(heal(1)), false, 0, 'skills');
    test('invalid-heal-ID', medic, one(heal(6)), false, 0, 'skills');
    for (const type of rules.units) {
      const others = rules.units
        .filter((value) => value.code !== type.code)
        .slice(0, 2)
        .map((value) => value.code);
      const state = board(map, [type.code, ...others, 1, 2, 3]);
      const skill =
        type.code === 1
          ? { ...hold(), actionType: 3 }
          : type.code === 3
            ? move([1], true)
            : type.code === 4
              ? heal(0)
              : attack(1, true);
      test(
        `skill-profession-${type.code}`,
        state,
        one(skill),
        true,
        type.skill.energyCost,
        'life-lock',
      );
      const locked = structuredClone(state);
      locked.units[0].lockedRound = 4;
      test(`locked-skill-${type.code}`, locked, one(skill), false, 0, 'life-lock');
      test(`locked-HOLD-${type.code}`, locked, bundle(), true, 0, 'life-lock');
      test(`locked-MOVE-${type.code}`, locked, one(move([1])), true, 0, 'life-lock');
      test(`locked-ATTACK-${type.code}`, locked, one(attack(1)), true, 0, 'life-lock');
      const dead = structuredClone(state);
      dead.units[0] = { ...dead.units[0], hp: 0, alive: false, position: 255, lockedRound: 0 };
      test(`dead-HOLD-${type.code}`, dead, bundle(), true, 0, 'life-lock');
      test(`dead-MOVE-${type.code}`, dead, one(move([1])), false, 0, 'life-lock');
      test(`dead-ATTACK-${type.code}`, dead, one(attack(1)), false, 0, 'life-lock');
      test(`dead-SKILL-${type.code}`, dead, one(skill), false, 0, 'life-lock');
    }
    const budget = board(map, undefined, [0, 2, 4]);
    const allSkills = [{ ...hold(), actionType: 3 }, heal(0), attack(3, true)];
    test('exact-team-budget', budget, allSkills, true, 5, 'budget');
    const overspend = structuredClone(budget);
    overspend.energy[0] = 4;
    test('team-budget-exceeded', overspend, allSkills, false, 0, 'budget');
    const expensive = board(map, [2, 4, 5, 1, 2, 3], [0, 2, 4]);
    test(
      'six-cost-exceeds-cap',
      expensive,
      [attack(1, true), heal(0), attack(3, true)],
      false,
      0,
      'budget',
    );
    const income = board(map, [4, 1, 5, 1, 2, 3], [map.resources[0]]);
    income.energy[0] = 1;
    test('income-cannot-pay-current-cost', income, one(heal(0)), false, 0, 'budget');
    const cover = map.cover[0];
    const neighbor = [cover - 1, cover + 1, cover - 8, cover + 8].find(
      (cell) =>
        cell >= 0 &&
        cell < 64 &&
        !map.obstacles.includes(cell) &&
        Math.abs((cell % 8) - (cover % 8)) +
          Math.abs(Math.floor(cell / 8) - Math.floor(cover / 8)) ===
          1,
    );
    assert.notEqual(neighbor, undefined);
    test(
      'vacant-Cover-is-walkable',
      board(map, undefined, [neighbor]),
      one(move([cover])),
      true,
      0,
      'Cover',
    );
    test(
      'occupied-Cover-is-blocked',
      board(map, undefined, [neighbor, undefined, undefined, cover]),
      one(move([cover])),
      false,
      0,
      'Cover',
    );
    test(
      'Cover-does-not-block-shot',
      board(map, [2, 4, 5, 1, 2, 3], [neighbor]),
      one(attack(cover)),
      true,
      0,
      'Cover',
    );
    test(
      'Cover-does-not-block-lock',
      board(map, [5, 4, 1, 1, 2, 3], [neighbor]),
      one(attack(cover, true)),
      true,
      2,
      'Cover',
    );
    test(
      'Cover-does-not-block-heal',
      board(map, [4, 1, 5, 1, 2, 3], [neighbor, cover]),
      one(heal(1)),
      true,
      2,
      'Cover',
    );
    for (const side of [2, 255])
      addBundle(
        `invalid-side:${map.mapId}:${side}`,
        base,
        bundle(),
        false,
        0,
        'state-boundary',
        side,
        false,
      );
    const malformed = structuredClone(base);
    malformed.units[1].position = malformed.units[0].position;
    test('duplicate-live-cells', malformed, bundle(), false, 0, 'state-boundary');
    const excessiveHP = structuredClone(base);
    excessiveHP.units[0].hp++;
    test('excessive-HP', excessiveHP, bundle(), false, 0, 'state-boundary');
    const ended = structuredClone(base);
    ended.outcome = 1;
    ended.reason = 5;
    test('terminal-state', ended, bundle(), false, 0, 'state-boundary');
    const capped = structuredClone(base);
    capped.completedRound = 20;
    test('no-round-after-cap', capped, bundle(), false, 0, 'state-boundary');
    test(
      'HOLD-unused-target',
      base,
      one({ ...hold(), targetCell: 1 }),
      false,
      0,
      'encoding',
      false,
    );
    test(
      'nonzero-unused-path-bits',
      base,
      one({ ...move([1]), pathBits: 2 ** 24 + 1 }),
      false,
      0,
      'encoding',
      false,
    );
  }
  for (let x = 0; x < 8; x++)
    for (let y = 0; y < 8; y++)
      add(
        `coordinates:${x}:${y}`,
        2,
        encode(parse('uint8,uint8'), [x, y]),
        encode(parse('uint8'), [y * 8 + x]),
        'coordinates',
      );
  for (const [x, y] of [
    [8, 0],
    [0, 8],
    [255, 0],
    [0, 255],
  ])
    add(
      `coordinates:invalid:${x}:${y}`,
      2,
      encode(parse('uint8,uint8'), [x, y]),
      undefined,
      'coordinates',
    );
  for (const mapId of [0, 4, 255])
    add(
      `terrain:unknown-map:${mapId}`,
      1,
      encode(parse('uint8,uint8'), [mapId, 0]),
      undefined,
      'terrain-boundary',
    );
  const pregame = structuredClone(references.rounds[0].input.state);
  pregame.battleStarted = false;
  pregame.completedRound = 0;
  pregame.energy = [0, 0];
  pregame.units = pregame.units.map(() => ({
    unitType: 0,
    position: 255,
    hp: 0,
    alive: false,
    lockedRound: 0,
  }));
  addBundle('pregame-rejects-orders', pregame, bundle(), false, 0, 'state-boundary', 0, false);
  const groups = Object.fromEntries(
    [...new Set(cases.map((row) => row.group))].map((group) => [
      group,
      cases.filter((row) => row.group === group).length,
    ]),
  );
  assert.equal(new Set(cases.map((row) => row.name)).size, cases.length);
  assert.equal(groups.terrain, 192);
  assert.equal(groups['reference-legal'], references.rounds.length * 2);
  assert.equal(groups['reference-rejection'], references.rejections.length * 2);
  return {
    cases,
    report: {
      scope:
        'actual Solidity static geometry, complete-bundle validation, required Energy and unchanged accepted inputs; no settlement or phase transactions',
      cases: cases.length,
      accepted: cases.filter((row) => row.valid).length,
      rejected: cases.filter((row) => !row.valid).length,
      groups,
      legalReferenceBundles: references.rounds.length * 2,
      rejectionReferenceBundles: references.rejections.length,
      pairedOpponentBundles: references.rejections.length,
      inputPreservation: 'pending',
    },
  };
}
