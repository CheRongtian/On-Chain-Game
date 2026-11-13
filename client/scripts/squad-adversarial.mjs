import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  toFunctionSelector,
  zeroHash,
} from 'viem';
import { readJson } from '../../scripts/deployment.mjs';
import { initialState } from '../../scripts/squad-baseline.mjs';
import { frameType, playSignedRounds } from './squad-turns.mjs';
import { advancePastDeadline } from './squad-timeouts.mjs';

const plain = (value) =>
  JSON.parse(
    JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item)),
  );
const salt = () => `0x${randomBytes(32).toString('hex')}`;
const holds = () =>
  Array.from({ length: 3 }, () => ({
    actionType: 0,
    targetCell: 255,
    targetUnit: 255,
    pathLength: 0,
    pathBits: 0,
  }));
const move = (...cells) => ({
  actionType: 1,
  targetCell: 255,
  targetUnit: 255,
  pathLength: cells.length,
  pathBits: cells.reduce((bits, cell, index) => bits + cell * 2 ** (6 * index), 0),
});

export async function checkAdversarialFixtures({ path, run, signal, report }) {
  report.stage = 'native-adversarial-protocol';
  report.adversarialNative = { status: 'running' };
  const file = path('.local/safety/squad-adversarial-tests.json');
  await Promise.all([
    writeFile(file, ''),
    ...['points', 'elimination'].map((name) =>
      writeFile(path(`.local/simulation/squad-rooms/match-${name}.abi`), ''),
    ),
  ]);
  const output = await run(
    'forge',
    [
      'test',
      '--match-contract',
      '^SquadAdversarialTest$',
      '--json-file',
      file,
      '--offline',
      '--use',
      path('.local/bin/solc-0.8.30'),
      '-vv',
    ],
    { cwd: path('contracts'), signal, maxBuffer: 8 * 1024 * 1024 },
  );
  process.stdout.write(output.stdout);
  if (output.stderr) process.stderr.write(output.stderr);
  const suites = Object.values(await readJson(file));
  assert.equal(suites.length, 1);
  assert.deepEqual(suites[0].warnings, []);
  const tests = Object.entries(suites[0].test_results).map(([name, test]) => {
    assert.equal(test.status, 'Success', `${name}: ${test.reason ?? 'native failure'}`);
    return name;
  });
  assert.equal(tests.length, 6);
  const artifact = await readJson(path('contracts/out/SquadArena.sol/SquadArena.json'));
  const selectors = [
    ...new Set(
      artifact.abi
        .filter((entry) => entry.type === 'error')
        .map((entry) =>
          toFunctionSelector(`${entry.name}(${entry.inputs.map((input) => input.type).join(',')})`),
        ),
    ),
  ].sort();
  const logger = await readFile(path('server/internal/localchain/log.go'), 'utf8');
  assert.deepEqual(
    [...logger.matchAll(/"(0x[\da-f]{8})"/g)].map((match) => match[1]).sort(),
    selectors,
    'Only compiled Squad contract business errors are quieted',
  );
  report.adversarialNative = { status: 'passed', tests, quietRevertSelectors: selectors };
  console.log(
    'PASS: six adversarial native cases: real VP/elimination games, same-context submission order, actual Commit storage and all terminal write entries.',
  );
}

export async function checkSignedAdversarial(context) {
  const {
    path,
    engine,
    result,
    report,
    config,
    codec,
    accounts,
    client,
    address,
    read,
    send,
    sendRejected,
    events,
    hashCases,
    rules,
    maps,
  } = context;
  assert.equal(report.adversarialNative.status, 'passed');
  const p = config.phases;
  const evidence = (result.adversarial = {
    status: 'running',
    games: [],
    prefixes: [],
    rejections: [],
    terminals: [],
    defaultsAfterRejectedReveal: [],
    hashedStates: 0,
    actionBundles: 0,
  });
  const caseStart = hashCases.length;
  const source = (sent) =>
    plain({
      hash: sent.receipt.transactionHash,
      blockNumber: sent.receipt.blockNumber,
      blockHash: sent.receipt.blockHash,
    });
  const ctx = (id) => ({ chainId: BigInt(result.chainId), arena: address, matchId: id });
  const rawSquad = (input, domain = config.domains[1].value) =>
    keccak256(
      encodeAbiParameters(
        parseAbiParameters(`bytes32,${config.types.context},address,bytes32,uint8[3],bytes32`),
        [domain, input.context, input.player, input.rulesetId, input.unitTypes, input.salt],
      ),
    );
  const rawTurn = (input, domain = config.domains[2].value) =>
    keccak256(
      encodeAbiParameters(
        parseAbiParameters(
          `bytes32,${config.types.context},uint16,address,bytes32,${config.types.action}[3],bytes32`,
        ),
        [
          domain,
          input.context,
          input.round,
          input.player,
          input.rulesetId,
          input.actions,
          input.salt,
        ],
      ),
    );
  async function snapshot(id, blockNumber) {
    const block = blockNumber ?? (await client.getBlockNumber({ cacheTime: 0 }));
    const values = await Promise.all(
      ['getMatch', 'getBattleState', 'getSquadStatus', 'getRoundStatus'].map((name) =>
        read(name, [id], block),
      ),
    );
    return { summary: values[0], state: values[1], squad: values[2], turn: values[3] };
  }
  async function rejected(id, side, functionName, args, errorName, label) {
    report.stage = `${engine}:adversarial:${label}`;
    const before = await snapshot(id);
    const failed = await sendRejected(side, functionName, args, errorName);
    assert.deepEqual(
      await snapshot(id, failed.receipt.blockNumber),
      before,
      `${label}: complete game-state rollback`,
    );
    evidence.rejections.push(
      plain({
        label,
        matchId: id,
        functionName,
        errorName,
        errorArgs: failed.errorArgs,
        transactionHash: failed.receipt.transactionHash,
        blockHash: failed.receipt.blockHash,
        blockNumber: failed.receipt.blockNumber,
        gasUsed: failed.receipt.gasUsed,
      }),
    );
  }
  async function waitingRoom(a = [1, 4, 5], b = [3, 2, 4]) {
    const created = await send(0, 'createMatch', [1]);
    const [creation, waiting] = events(created.receipt, ['MatchCreated', 'PhaseAdvanced']);
    const id = creation.matchId;
    assert.equal(creation.rulesetId, config.rulesetId);
    assert.equal(creation.mapId, 1);
    assert.equal(creation.mapHash, config.ruleDefinition.mapHashes[0]);
    assert.equal(waiting.toPhase, p.WAITING);
    const joined = await send(1, 'joinMatch', [id]);
    const [joinEvent] = events(joined.receipt, ['PlayerJoined']);
    assert.equal((await read('getMatch', [id])).phase, p.WAITING, 'Join does not start');
    const inputs = accounts.map((account, side) => ({
      context: ctx(id),
      player: account.address,
      rulesetId: config.rulesetId,
      unitTypes: side === 0 ? a : b,
      salt: salt(),
    }));
    return {
      id,
      inputs,
      creation,
      setup: plain({
        creation: { ...creation, source: source(created) },
        join: { ...joinEvent, source: source(joined) },
      }),
    };
  }
  async function startRoom(stage) {
    assert.equal(
      (await read('getMatch', [stage.id])).phase,
      p.WAITING,
      'Host start requires a Waiting fixture',
    );
    const started = await send(0, 'startMatch', [stage.id]);
    const [event] = events(started.receipt, ['PhaseAdvanced']);
    assert.deepEqual(event, {
      matchId: stage.id,
      round: 0,
      fromPhase: p.WAITING,
      toPhase: p.SQUAD_COMMIT,
      deadline: started.timestamp + BigInt(config.ruleDefinition.windows[1]),
    });
    stage.setup.hostStart = plain({ ...event, source: source(started) });
    return stage;
  }
  async function open(a, b) {
    return startRoom(await waitingRoom(a, b));
  }
  async function commitSquads(stage, inputs = stage.inputs) {
    for (const side of [0, 1]) await send(side, 'commitSquad', [stage.id, rawSquad(inputs[side])]);
  }
  async function revealSquads(stage) {
    let initial;
    const reveals = [];
    for (const side of [0, 1]) {
      const input = stage.inputs[side];
      const sent = await send(side, 'revealSquad', [stage.id, input.unitTypes, input.salt]);
      const logs = events(
        sent.receipt,
        side === 0 ? ['SquadRevealed'] : ['SquadRevealed', 'GameStarted', 'PhaseAdvanced'],
      );
      assert.deepEqual(logs[0], {
        matchId: stage.id,
        player: input.player,
        unitTypes: input.unitTypes,
        salt: input.salt,
      });
      reveals.push({ ...logs[0], source: source(sent) });
      const status = await snapshot(stage.id, sent.receipt.blockNumber);
      if (side === 0) {
        assert.equal(status.state.battleStarted, false);
        assert.deepEqual(status.squad.unitTypes[1], [0, 0, 0]);
        assert.equal(status.squad.revealed[1], false);
      } else {
        initial = logs[1];
        const reconstructed = initialState(
          {
            mapId: stage.creation.mapId,
            side: 0,
            squad: reveals[0].unitTypes,
            opponent: reveals[1].unitTypes,
          },
          rules,
          maps,
        );
        assert.deepEqual(
          initial.initialState,
          reconstructed,
          'Initial state reconstructed from public lineups and catalogue',
        );
        assert.equal(
          initial.stateHash,
          keccak256(
            codec.encodeState({
              context: ctx(stage.id),
              rulesetId: stage.creation.rulesetId,
              state: reconstructed,
            }),
          ),
        );
        assert.deepEqual(status.state, initial.initialState);
        assert.equal(status.summary.stateHash, initial.stateHash);
        assert.equal(status.summary.phase, p.ROUND_COMMIT);
        assert.equal(status.summary.activeRound, 1);
        assert.equal(status.summary.phaseDeadline, sent.timestamp + 600n);
      }
    }
    return {
      context: ctx(stage.id),
      rulesetId: config.rulesetId,
      state: initial.initialState,
      stateHash: initial.stateHash,
      setup: { ...stage.setup, squadReveals: plain(reveals) },
    };
  }
  async function initialized(a, b) {
    const stage = await open(a, b);
    await commitSquads(stage);
    return { ...stage, start: await revealSquads(stage) };
  }
  function actionsInput(stage, side, actions, state) {
    const own = state.units.slice(side * 3, side * 3 + 3);
    return {
      context: ctx(stage.id),
      player: accounts[side].address,
      rulesetId: config.rulesetId,
      round: state.completedRound + 1,
      side,
      unitTypes: own.map((u) => u.unitType),
      alive: own.map((u) => u.alive),
      lockedRound: own.map((u) => u.lockedRound),
      actions,
      salt: salt(),
    };
  }
  async function closeMissing(stage, phase) {
    const before = await snapshot(stage.id);
    assert.equal(phase, p.ROUND_REVEAL);
    assert.equal(before.summary.phase, phase);
    assert.deepEqual(before.turn.revealed, [true, false]);
    await advancePastDeadline(client, engine, before.summary.phaseDeadline);
    const sent = await send(2, 'advanceExpiredPhase', [
      stage.id,
      before.summary.activeRound,
      phase,
    ]);
    const logs = events(sent.receipt, ['PhaseAdvanced', 'MatchFinished']);
    const expectedState = { ...before.state, outcome: 1, reason: 6 };
    const input = { context: ctx(stage.id), rulesetId: config.rulesetId, state: expectedState };
    const encoding = codec.encodeState(input);
    const hash = keccak256(encoding);
    const after = await snapshot(stage.id, sent.receipt.blockNumber);
    assert.deepEqual(
      after,
      {
        ...before,
        state: expectedState,
        summary: {
          ...before.summary,
          phase: p.FINISHED,
          phaseDeadline: 0n,
          outcome: 1,
          reason: 6,
          stateHash: hash,
        },
      },
      'Rejected Reveal cannot turn a missing player into the winner or resolve another round',
    );
    assert.deepEqual(logs[1], {
      matchId: stage.id,
      round: before.summary.activeRound,
      winner: accounts[0].address,
      battleStarted: true,
      completedRound: before.state.completedRound,
      outcome: 1,
      reason: 6,
      stateHash: hash,
    });
    hashCases.push({
      name: `${engine}:rejected-reveal-default:${stage.id}`,
      kind: 4,
      input: plain(input),
      expectedEncoding: encoding,
      expectedHash: hash,
    });
    evidence.defaultsAfterRejectedReveal.push(
      plain({ matchId: stage.id, before, after, source: source(sent) }),
    );
  }
  async function loadFrames(name) {
    return decodeAbiParameters(
      parseAbiParameters(`${frameType(config)}[]`),
      (await readFile(path(`.local/simulation/squad-rooms/${name}.abi`), 'utf8')).trim(),
    )[0];
  }
  for (const [name, reason] of [
    ['points', 3],
    ['elimination', 1],
  ]) {
    const frames = await loadFrames(`match-${name}`);
    assert.ok(frames.length > 0 && frames.length <= 20);
    assert.equal(frames.at(-1).next.outcome, 1);
    assert.equal(frames.at(-1).next.reason, reason);
    const types = frames[0].initial.units.map((u) => u.unitType);
    const stage = await initialized(types.slice(0, 3), types.slice(3));
    assert.deepEqual(stage.start.state, frames[0].initial);
    const encoding = codec.encodeState({
      context: ctx(stage.id),
      rulesetId: config.rulesetId,
      state: stage.start.state,
    });
    assert.equal(keccak256(encoding), stage.start.stateHash);
    hashCases.push({
      name: `${engine}:${name}:initial`,
      kind: 4,
      input: plain({
        context: ctx(stage.id),
        rulesetId: config.rulesetId,
        state: stage.start.state,
      }),
      expectedEncoding: encoding,
      expectedHash: stage.start.stateHash,
    });
    const game = { name, reason, setup: stage.start.setup };
    evidence.games.push(game);
    await playSignedRounds({ ...context, start: stage.start, frames, name, battle: game });
    console.log(
      `PASS: ${engine} complete ${name} game: hidden squads, ${frames.length} signed rounds, public events, actual effects and correct terminal result.`,
    );
  }

  let stage = await waitingRoom();
  for (const mapId of [0, 4, 255])
    await rejected(stage.id, 0, 'createMatch', [mapId], 'UnknownMap', `map-${mapId}`);
  await rejected(stage.id, 1, 'startMatch', [stage.id], 'NotCreator', 'non-host-start');
  await startRoom(stage);
  await rejected(
    stage.id,
    1,
    'startMatch',
    [stage.id],
    'InvalidPhase',
    'non-host-start-after-opening',
  );
  await rejected(stage.id, 2, 'commitSquad', [stage.id, zeroHash], 'NotPlayer', 'outsider-squad');
  await rejected(
    stage.id,
    0,
    'revealSquad',
    [stage.id, stage.inputs[0].unitTypes, stage.inputs[0].salt],
    'InvalidPhase',
    'early-squad-reveal',
  );
  await send(0, 'commitSquad', [stage.id, rawSquad(stage.inputs[0])]);
  await rejected(
    stage.id,
    0,
    'commitSquad',
    [stage.id, zeroHash],
    'AlreadyCommitted',
    'replace-squad-commitment',
  );
  await send(1, 'commitSquad', [stage.id, rawSquad(stage.inputs[1])]);
  await rejected(
    stage.id,
    0,
    'commitSquad',
    [stage.id, zeroHash],
    'InvalidPhase',
    'commit-after-squad-phase',
  );
  await rejected(
    stage.id,
    0,
    'revealSquad',
    [stage.id, stage.inputs[0].unitTypes, salt()],
    'CommitmentMismatch',
    'wrong-squad-salt',
  );
  await rejected(
    stage.id,
    0,
    'revealSquad',
    [stage.id, [4, 1, 5], stage.inputs[0].salt],
    'CommitmentMismatch',
    'changed-squad-order',
  );
  events(
    (await send(0, 'revealSquad', [stage.id, stage.inputs[0].unitTypes, stage.inputs[0].salt]))
      .receipt,
    ['SquadRevealed'],
  );
  assert.deepEqual(
    (await read('getSquadStatus', [stage.id])).revealed,
    [true, false],
    'Original Squad retry succeeds',
  );
  await rejected(
    stage.id,
    0,
    'revealSquad',
    [stage.id, stage.inputs[0].unitTypes, stage.inputs[0].salt],
    'AlreadyRevealed',
    'duplicate-squad-reveal',
  );
  events(
    (await send(1, 'revealSquad', [stage.id, stage.inputs[1].unitTypes, stage.inputs[1].salt]))
      .receipt,
    ['SquadRevealed', 'GameStarted', 'PhaseAdvanced'],
  );
  let state = await read('getBattleState', [stage.id]);
  let inputs = [0, 1].map((side) => actionsInput(stage, side, holds(), state));
  await rejected(
    stage.id,
    0,
    'commitActions',
    [stage.id, 0, zeroHash],
    'StaleRound',
    'stale-action-round',
  );
  await rejected(
    stage.id,
    0,
    'revealActions',
    [stage.id, 1, inputs[0].actions, inputs[0].salt],
    'InvalidPhase',
    'early-action-reveal',
  );
  await rejected(
    stage.id,
    2,
    'commitActions',
    [stage.id, 1, zeroHash],
    'NotPlayer',
    'outsider-action',
  );
  await send(0, 'commitActions', [stage.id, 1, rawTurn(inputs[0])]);
  await rejected(
    stage.id,
    0,
    'commitActions',
    [stage.id, 1, zeroHash],
    'AlreadyCommitted',
    'replace-action-commitment',
  );
  await send(1, 'commitActions', [stage.id, 1, rawTurn(inputs[1])]);
  await rejected(
    stage.id,
    0,
    'revealActions',
    [stage.id, 1, inputs[0].actions, salt()],
    'CommitmentMismatch',
    'wrong-action-salt',
  );
  events(
    (await send(0, 'revealActions', [stage.id, 1, inputs[0].actions, inputs[0].salt])).receipt,
    ['ActionRevealed'],
  );
  assert.deepEqual(
    (await read('getRoundStatus', [stage.id])).revealed,
    [true, false],
    'Original orders retry succeeds',
  );
  await rejected(
    stage.id,
    0,
    'revealActions',
    [stage.id, 1, inputs[0].actions, inputs[0].salt],
    'AlreadyRevealed',
    'duplicate-action-reveal',
  );
  await closeMissing(stage, p.ROUND_REVEAL);

  const mutations = [
    ['chain', (input) => input.context.chainId++],
    [
      'arena',
      (input) => {
        input.context.arena = result.originalArena;
      },
    ],
    ['match', (input) => input.context.matchId++],
    [
      'player',
      (input) => {
        input.player = accounts[1].address;
      },
    ],
    [
      'ruleset',
      (input) => {
        input.rulesetId = zeroHash;
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    stage = await open();
    const foreign = structuredClone(stage.inputs);
    mutate(foreign[0]);
    await commitSquads(stage, foreign);
    await rejected(
      stage.id,
      0,
      'revealSquad',
      [stage.id, stage.inputs[0].unitTypes, stage.inputs[0].salt],
      'CommitmentMismatch',
      `squad-context-${name}`,
    );
  }
  stage = await open();
  await send(0, 'commitSquad', [stage.id, rawSquad(stage.inputs[0], config.domains[2].value)]);
  await send(1, 'commitSquad', [stage.id, rawSquad(stage.inputs[1])]);
  await rejected(
    stage.id,
    0,
    'revealSquad',
    [stage.id, stage.inputs[0].unitTypes, stage.inputs[0].salt],
    'CommitmentMismatch',
    'wrong-squad-domain',
  );
  for (const types of [
    [1, 1, 3],
    [0, 2, 3],
    [1, 2, 6],
  ]) {
    stage = await open(types, [3, 2, 4]);
    await commitSquads(stage);
    await rejected(
      stage.id,
      0,
      'revealSquad',
      [stage.id, types, stage.inputs[0].salt],
      'InvalidProtocol',
      `invalid-squad-${types.join('-')}`,
    );
    await rejected(
      stage.id,
      0,
      'revealSquad',
      [stage.id, [1, 2, 3], stage.inputs[0].salt],
      'CommitmentMismatch',
      `invalid-squad-cannot-replace-${types.join('-')}`,
    );
  }
  for (const [name, mutate] of [...mutations, ['round', (input) => input.round++]]) {
    stage = await initialized();
    state = await read('getBattleState', [stage.id]);
    inputs = [0, 1].map((side) => actionsInput(stage, side, holds(), state));
    const foreign = structuredClone(inputs[0]);
    mutate(foreign);
    await send(0, 'commitActions', [stage.id, 1, rawTurn(foreign)]);
    await send(1, 'commitActions', [stage.id, 1, rawTurn(inputs[1])]);
    await rejected(
      stage.id,
      0,
      'revealActions',
      [stage.id, 1, inputs[0].actions, inputs[0].salt],
      'CommitmentMismatch',
      `action-context-${name}`,
    );
  }
  stage = await initialized();
  state = await read('getBattleState', [stage.id]);
  inputs = [0, 1].map((side) => actionsInput(stage, side, holds(), state));
  await send(0, 'commitActions', [stage.id, 1, rawTurn(inputs[0], config.domains[1].value)]);
  await send(1, 'commitActions', [stage.id, 1, rawTurn(inputs[1])]);
  await rejected(
    stage.id,
    0,
    'revealActions',
    [stage.id, 1, inputs[0].actions, inputs[0].salt],
    'CommitmentMismatch',
    'wrong-action-domain',
  );

  const malformed = [
    [
      'hold-target',
      (a) => {
        a[0].targetCell = 0;
      },
    ],
    [
      'unused-path',
      (a) => {
        a[0].pathBits = 1;
      },
    ],
    [
      'guardian-path-limit',
      (a) => {
        a[0] = move(9, 10);
      },
    ],
    [
      'enemy-heal',
      (a) => {
        a[1] = { actionType: 3, targetCell: 255, targetUnit: 3, pathLength: 0, pathBits: 0 };
      },
    ],
    [
      'distant-lock',
      (a) => {
        a[2] = { actionType: 3, targetCell: 43, targetUnit: 255, pathLength: 0, pathBits: 0 };
      },
    ],
    [
      'shield-target',
      (a) => {
        a[0] = { actionType: 3, targetCell: 0, targetUnit: 255, pathLength: 0, pathBits: 0 };
      },
    ],
    [
      'overspend',
      (a) => {
        a[1] = { actionType: 3, targetCell: 255, targetUnit: 1, pathLength: 0, pathBits: 0 };
        a[2] = { actionType: 3, targetCell: 48, targetUnit: 255, pathLength: 0, pathBits: 0 };
      },
    ],
    [
      'obstacle-path',
      (a) => {
        a[1] = move(25, 17);
      },
    ],
    [
      'occupied-origin',
      (a) => {
        a[1] = move(16, 8);
      },
    ],
    [
      'nonadjacent-path',
      (a) => {
        a[1] = move(26);
      },
    ],
    [
      'repeated-cell',
      (a) => {
        a[1] = move(25, 25);
      },
    ],
    [
      'high-path-bits',
      (a) => {
        a[0] = move(9);
        a[0].pathBits += 2 ** 25;
      },
    ],
    [
      'unknown-action',
      (a) => {
        a[0].actionType = 4;
      },
    ],
    [
      'unknown-heal-unit',
      (a) => {
        a[1] = { actionType: 3, targetCell: 255, targetUnit: 6, pathLength: 0, pathBits: 0 };
      },
    ],
  ];
  for (const [name, mutate] of malformed) {
    stage = await initialized();
    state = await read('getBattleState', [stage.id]);
    const actions = holds();
    mutate(actions);
    inputs = [actionsInput(stage, 0, actions, state), actionsInput(stage, 1, holds(), state)];
    await send(0, 'commitActions', [stage.id, 1, rawTurn(inputs[0])]);
    await send(1, 'commitActions', [stage.id, 1, rawTurn(inputs[1])]);
    await send(1, 'revealActions', [stage.id, 1, inputs[1].actions, inputs[1].salt]);
    await rejected(
      stage.id,
      0,
      'revealActions',
      [stage.id, 1, actions, inputs[0].salt],
      'InvalidProtocol',
      `malformed-${name}`,
    );
    await rejected(
      stage.id,
      0,
      'revealActions',
      [stage.id, 1, holds(), inputs[0].salt],
      'CommitmentMismatch',
      `replace-malformed-${name}`,
    );
  }

  for (const [name, file, length] of [
    ['locked-skill', 'battle-sequence', 4],
    ['dead-slot', 'match-elimination', 7],
  ]) {
    const frames = (await loadFrames(file)).slice(0, length);
    const types = frames[0].initial.units.map((u) => u.unitType);
    stage = await initialized(types.slice(0, 3), types.slice(3));
    const prefix = { name, setup: stage.start.setup };
    evidence.prefixes.push(prefix);
    await playSignedRounds({ ...context, start: stage.start, frames, name, battle: prefix });
    state = await read('getBattleState', [stage.id]);
    const round = state.completedRound + 1;
    const actions = holds();
    if (name === 'locked-skill') {
      assert.equal(state.units[3].lockedRound, round);
      actions[0] = { actionType: 3, targetCell: 255, targetUnit: 255, pathLength: 1, pathBits: 51 };
    } else {
      assert.equal(state.units[3].alive, false);
      actions[0] = move(49);
    }
    inputs = [actionsInput(stage, 0, holds(), state), actionsInput(stage, 1, actions, state)];
    for (const side of [0, 1])
      await send(side, 'commitActions', [stage.id, round, rawTurn(inputs[side])]);
    await send(0, 'revealActions', [stage.id, round, inputs[0].actions, inputs[0].salt]);
    await rejected(
      stage.id,
      1,
      'revealActions',
      [stage.id, round, actions, inputs[1].salt],
      'InvalidProtocol',
      name,
    );
    await closeMissing(stage, p.ROUND_REVEAL);
  }

  const candidates = [
    ...evidence.games.map((game) => BigInt(game.matchId)),
    ...result.timeouts.cases.map((row) => BigInt(row.matchId)),
  ];
  const terminalKinds = new Set();
  for (const id of new Set(candidates)) {
    const closed = await read('getMatch', [id]);
    if (![p.FINISHED, p.CANCELLED, p.EXPIRED].includes(closed.phase)) continue;
    const key = `${closed.phase}:${closed.outcome}:${closed.reason}`;
    if (terminalKinds.has(key)) continue;
    terminalKinds.add(key);
    const round = closed.activeRound;
    const calls = [
      ['joinMatch', [id]],
      ['startMatch', [id]],
      ['cancelWaitingMatch', [id]],
      ['expireWaitingMatch', [id]],
      ['commitSquad', [id, zeroHash]],
      ['revealSquad', [id, [1, 2, 3], zeroHash]],
      ['commitActions', [id, round, zeroHash]],
      ['revealActions', [id, round, holds(), zeroHash]],
      ['settleRound', [id, round]],
      ['advanceExpiredPhase', [id, round, p.ROUND_COMMIT]],
    ];
    for (const [functionName, args] of calls)
      await rejected(id, 0, functionName, args, 'InvalidPhase', `terminal-${key}-${functionName}`);
    evidence.terminals.push({
      matchId: id.toString(),
      phase: closed.phase,
      outcome: closed.outcome,
      reason: closed.reason,
      entries: calls.length,
    });
  }
  assert.equal(evidence.games.length, 2);
  assert.equal(evidence.prefixes.length, 2);
  assert.equal(evidence.defaultsAfterRejectedReveal.length, 3);
  assert.equal(
    terminalKinds.size,
    16,
    'Two normal victories, twelve default outcomes and two waiting closures',
  );
  assert.ok(evidence.rejections.length >= 200, 'Actual signed attacks and all terminal entries');
  evidence.hashedStates = hashCases.slice(caseStart).filter((row) => row.kind === 4).length;
  evidence.actionBundles = hashCases.slice(caseStart).filter((row) => row.kind === 3).length;
  evidence.status = 'passed';
  console.log(
    `PASS: ${engine} adversarial protocol: ${evidence.rejections.length} confirmed rejected transactions with exact errors and full rollback; both victories, locked/dead-slot rejection, sixteen terminal outcomes and public history/hash checks.`,
  );
}
