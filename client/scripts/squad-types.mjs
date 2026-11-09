import assert from 'node:assert/strict';

// Runtime probes receive map/type inputs only; expected units and hashes stay in the checker.
export function prepareSquadTypes(config, rules, maps, baseline, abi, viem) {
  const { encodeAbiParameters: encode, parseAbiParameters: parse } = viem;
  const cases = [];
  const initialType = `(${config.types.context} context,uint8 mapId,uint8[3] typesA,uint8[3] typesB)`;
  const initialParameters = parse(initialType);
  const expectedInitial = parse(`${config.types.state},bytes32`);
  const add = (name, kind, payload, expectedEncoding, expectedHash) =>
    cases.push({
      name,
      kind,
      payload,
      valid: expectedEncoding !== undefined,
      expectedEncoding,
      expectedHash,
    });
  const referenceRows = baseline.cases.slice(0, baseline.report.initializations);
  assert.equal(referenceRows.length, 360);
  const context = referenceRows[0].input.context;
  const nativeContext = {
    ...context,
    chainId: BigInt(context.chainId),
    matchId: BigInt(context.matchId),
  };
  const initialInput = (mapId, typesA, typesB) =>
    encode(initialParameters, [{ context: nativeContext, mapId, typesA, typesB }]);
  for (const row of referenceRows) {
    const state = row.input.state;
    add(
      `runtime:${row.name}`,
      6,
      initialInput(
        state.mapId,
        state.units.slice(0, 3).map((unit) => unit.unitType),
        state.units.slice(3).map((unit) => unit.unitType),
      ),
      encode(expectedInitial, [state, row.expectedHash]),
    );
  }
  const badSquads = [
    [1, 1, 2],
    [1, 2, 1],
    [2, 1, 1],
    [5, 5, 5],
    [0, 2, 3],
    [1, 2, 6],
    [255, 1, 2],
  ];
  const good = [1, 4, 5];
  for (const map of maps)
    for (const types of badSquads)
      for (const side of [0, 1])
        add(
          `runtime:invalid-squad:${map.mapId}:${side}:${types.join('-')}`,
          6,
          initialInput(map.mapId, side === 0 ? types : good, side === 1 ? types : good),
        );
  for (const mapId of [0, 4, 255])
    add(`runtime:invalid-map:${mapId}`, 6, initialInput(mapId, good, good));
  const unitParameters = parse(config.types.unit);
  const unitCase = (name, input, expected) =>
    add(
      name,
      7,
      encode(unitParameters, [input]),
      expected ? encode(unitParameters, [expected]) : undefined,
    );
  for (const type of rules.units) {
    const live = { unitType: type.code, position: 0, hp: type.maxHp, alive: true, lockedRound: 0 };
    const edge = { ...live, position: 63, hp: 1, lockedRound: 21 };
    const dying = { ...live, position: 8, hp: 0, lockedRound: 4 };
    const dead = { ...live, position: 255, hp: 0, alive: false, lockedRound: 0 };
    unitCase(`runtime:live-unit:${type.code}`, live, live);
    unitCase(`runtime:live-unit-edge:${type.code}`, edge, edge);
    unitCase(`runtime:death:${type.code}`, dying, dead);
    unitCase(`runtime:death-idempotence:${type.code}`, dead, dead);
    for (const [field, value] of [
      ['hp', type.maxHp + 1],
      ['alive', false],
      ['position', 64],
      ['position', 255],
      ['lockedRound', 22],
      ['lockedRound', 65535],
    ])
      unitCase(`runtime:invalid-unit:${type.code}:${field}:${value}`, { ...live, [field]: value });
  }
  for (const unitType of [0, 6, 255])
    unitCase(`runtime:invalid-profession:${unitType}`, {
      unitType,
      position: 0,
      hp: 1,
      alive: true,
      lockedRound: 0,
    });
  const normalizations = cases.filter((row) => row.kind === 7).length;
  add(
    'runtime:ruleset-definition',
    8,
    '0x',
    encode(parse(config.encodings.ruleset), [config.domains[0].value, config.ruleDefinition]),
    config.rulesetId,
  );
  const getMap = abi.find((item) => item.type === 'function' && item.name === 'getMap');
  for (const map of maps) {
    const expected = {
      mapId: map.mapId,
      width: map.width,
      height: map.height,
      obstacles: BigInt(map.bitmaps.obstacles),
      cover: BigInt(map.bitmaps.cover),
      resources: BigInt(map.bitmaps.resources),
      controlZone: BigInt(map.bitmaps.controlZone),
      spawnsA: map.spawns.A,
      spawnsB: map.spawns.B,
      mapHash: map.mapHash,
    };
    add(
      `runtime:map-catalogue:${map.mapId}`,
      9,
      encode(parse('uint8'), [map.mapId]),
      encode(getMap.outputs, [expected]),
    );
  }
  const original = baseline.manifest.profiles.find((profile) => profile.engine === 'fixed');
  add(
    'runtime:match-and-contract-isolation',
    10,
    encode(parse('bytes32'), [original.rulesetId]),
    encode(parse('bool'), [true]),
  );
  return {
    cases,
    report: {
      scope:
        'actual Solidity rules, map catalogue, initialization, unit normalization and internal storage/context isolation; no phase transactions or resolver',
      initializations: referenceRows.length,
      orderedSquads: baseline.report.orderedSquads,
      maps: maps.length,
      sides: 2,
      initializationRejections: badSquads.length * maps.length * 2 + 3,
      unitNormalizations: normalizations,
      rulesetId: config.rulesetId,
      actualSolidityCases: cases.length,
      accepted: cases.filter((row) => row.valid).length,
      rejected: cases.filter((row) => !row.valid).length,
      matchStorageIsolation: 'pending',
      contractStorageIsolation: 'pending',
      contextHashIsolation: ['match', 'arena', 'chain', 'original-rules-identity'],
    },
  };
}
