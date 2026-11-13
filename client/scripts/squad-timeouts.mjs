import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ContractFunctionRevertedError, keccak256, zeroHash } from 'viem';
import { readJson } from '../../scripts/deployment.mjs';

const plain = (value) =>
  JSON.parse(
    JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item)),
  );
const gasNames = [
  'cancel',
  'expiry',
  'squad-commit',
  'squad-reveal',
  'round-commit',
  'round-reveal',
];

export async function checkTimeoutFixtures({ path, run, signal, report }) {
  report.stage = 'native-timeout-protocol';
  report.timeoutNative = { status: 'running' };
  const nativeFile = path('.local/safety/squad-timeout-tests.json');
  const gasFile = path('.local/safety/squad-timeout-gas-tests.json');
  const snapshot = path('.local/safety/squad-timeout-gas.snapshot');
  await Promise.all([
    ...[nativeFile, gasFile, snapshot].map((file) => writeFile(file, '')),
    ...gasNames.map((name) => writeFile(path(`.local/safety/squad-timeout-gas-${name}.json`), '')),
  ]);
  async function forge(args, file) {
    const output = await run(
      'forge',
      [...args, '--json-file', file, '--offline', '--use', path('.local/bin/solc-0.8.30'), '-vv'],
      { cwd: path('contracts'), signal, maxBuffer: 8 * 1024 * 1024 },
    );
    process.stdout.write(output.stdout);
    if (output.stderr) process.stderr.write(output.stderr);
    const suites = Object.entries(await readJson(file));
    assert.equal(suites.length, 1);
    return suites.flatMap(([suite, outcome]) => {
      assert.deepEqual(outcome.warnings, [], `${suite}: warnings`);
      return Object.entries(outcome.test_results).map(([name, test]) => {
        assert.equal(test.status, 'Success', `${name}: ${test.reason ?? 'native failure'}`);
        return { name, kind: test.kind };
      });
    });
  }
  const tests = await forge(
    [
      'test',
      '--match-contract',
      '^SquadTimeoutTest$',
      '--fuzz-seed',
      report.seed,
      '--fuzz-runs',
      '64',
    ],
    nativeFile,
  );
  assert.equal(tests.length, 12);
  const fuzz = tests.filter((test) => test.kind.Fuzz);
  assert.equal(fuzz.length, 1);
  assert.equal(fuzz[0].kind.Fuzz.runs, 64);
  report.stage = 'native-timeout-gas';
  const gasTests = await forge(
    ['snapshot', '--match-contract', '^SquadTimeoutGasTest$', '--isolate', '--snap', snapshot],
    gasFile,
  );
  assert.equal(gasTests.length, 6);
  const gas = await Promise.all(
    gasNames.map((name) => readJson(path(`.local/safety/squad-timeout-gas-${name}.json`))),
  );
  for (const [index, sample] of gas.entries()) {
    assert.equal(sample.name, gasNames[index]);
    assert.ok(
      Number.isInteger(sample.gasUsed) && sample.gasUsed >= 21_000 && sample.gasUsed < 30_000_000,
    );
  }
  report.timeoutNative = {
    status: 'passed',
    tests,
    fuzzRuns: 64,
    gas,
    gasScope:
      'Isolated external-call deltas include intrinsic Gas. Cancellation/timeout costs are recorded without inventing new engineering budgets; each must fit the existing 30M local block limit.',
    snapshot: await readFile(snapshot, 'utf8'),
  };
  console.log(
    'PASS: all four timeout/default branches, waiting cancellation/expiry, strict deadlines, stale/competing calls, terminal immutability and six recorded Gas samples.',
  );
}

export async function checkSignedTimeouts({
  engine,
  result,
  report,
  config,
  codec,
  accounts,
  signers,
  client,
  abi,
  address,
  read,
  send,
  events,
  race,
  hashCases,
}) {
  assert.equal(report.timeoutNative.status, 'passed');
  const p = config.phases;
  const evidence = (result.timeouts = {
    status: 'running',
    publicExecutor: signers[2].address,
    cases: [],
    gas: [],
    races: [],
    hashedStates: 0,
  });
  const salt = () => `0x${randomBytes(32).toString('hex')}`;
  const holds = () =>
    Array.from({ length: 3 }, () => ({
      actionType: 0,
      targetCell: 255,
      targetUnit: 255,
      pathLength: 0,
      pathBits: 0,
    }));
  const reason = (phase) =>
    phase === p.SQUAD_COMMIT ? 7 : phase === p.SQUAD_REVEAL ? 8 : phase === p.ROUND_COMMIT ? 5 : 6;
  const context = (id) => ({ chainId: BigInt(result.chainId), arena: address, matchId: id });
  async function snapshot(id, blockNumber) {
    const block = blockNumber ?? (await client.getBlockNumber({ cacheTime: 0 }));
    const values = await Promise.all(
      ['getMatch', 'getBattleState', 'getSquadStatus', 'getRoundStatus'].map((name) =>
        read(name, [id], block),
      ),
    );
    return { summary: values[0], state: values[1], squad: values[2], turn: values[3] };
  }
  async function rejected(functionName, args, side, errorName) {
    try {
      await client.simulateContract({
        address,
        abi,
        account: signers[side].address,
        functionName,
        args,
      });
    } catch (error) {
      const revert = error.walk?.((cause) => cause instanceof ContractFunctionRevertedError);
      assert.equal(
        revert?.data?.errorName,
        errorName,
        `${functionName}: expected ${errorName}, received ${error.shortMessage ?? error.message.split('\n')[0]}`,
      );
      return;
    }
    assert.fail(`${functionName}: expected ${errorName}`);
  }
  async function clockAfter(deadline) {
    const target = deadline + 1n;
    const head = await client.getBlock();
    if (head.timestamp >= target) return;
    if (engine === 'geth')
      await client.request({ method: 'arena_advanceClock', params: [`0x${target.toString(16)}`] });
    else {
      await client.request({ method: 'evm_setNextBlockTimestamp', params: [Number(target)] });
      await client.request({ method: 'evm_mine', params: [] });
    }
  }
  function gas(operation, sent, label) {
    const used = Number(sent.receipt.gasUsed);
    assert.ok(used <= Number(sent.blockGasLimit), `${operation}: Gas fits canonical block`);
    if (operation === 'settle')
      assert.ok(used < 1_500_000, 'Competing settlement retains existing Gas budget');
    evidence.gas.push({
      operation,
      label,
      status: sent.receipt.status,
      hash: sent.receipt.transactionHash,
      gasUsed: used,
      blockGasLimit: Number(sent.blockGasLimit),
    });
  }
  function stateCase(id, state, hash, name) {
    const input = { context: context(id), rulesetId: config.rulesetId, state };
    const encoding = codec.encodeState(input);
    assert.equal(keccak256(encoding), hash, `${name}: canonical state Hash`);
    hashCases.push({
      name: `${engine}:${name}:match-${id}`,
      kind: 4,
      input: plain(input),
      expectedEncoding: encoding,
      expectedHash: hash,
    });
    evidence.hashedStates++;
  }
  async function setup(phase, mask = 0, joinedWaiting = false) {
    const created = await send(0, 'createMatch', [1]);
    const [creation] = events(created.receipt, ['MatchCreated', 'PhaseAdvanced']);
    const id = creation.matchId;
    const squadInputs = accounts.map((account, side) => ({
      context: context(id),
      player: account.address,
      rulesetId: config.rulesetId,
      unitTypes: side === 0 ? [1, 4, 5] : [3, 2, 4],
      salt: salt(),
    }));
    const actions = [holds(), holds()];
    const actionInputs = squadInputs.map((input, side) => ({
      ...input,
      side,
      round: 1,
      alive: [true, true, true],
      lockedRound: [0, 0, 0],
      actions: actions[side],
      salt: salt(),
    }));
    if (phase === p.WAITING) {
      if (joinedWaiting) events((await send(1, 'joinMatch', [id])).receipt, ['PlayerJoined']);
      return { id, squadInputs, actionInputs, actions };
    }
    events((await send(1, 'joinMatch', [id])).receipt, ['PlayerJoined']);
    events((await send(0, 'startMatch', [id])).receipt, ['PhaseAdvanced']);
    for (const side of [0, 1])
      if (phase > p.SQUAD_COMMIT || mask & (1 << side))
        await send(side, 'commitSquad', [id, keccak256(codec.encodeSquad(squadInputs[side]))]);
    for (const side of [0, 1])
      if (phase > p.SQUAD_REVEAL || (phase === p.SQUAD_REVEAL && mask & (1 << side)))
        await send(side, 'revealSquad', [id, squadInputs[side].unitTypes, squadInputs[side].salt]);
    if (phase >= p.ROUND_COMMIT) {
      for (const side of [0, 1])
        if (phase > p.ROUND_COMMIT || mask & (1 << side))
          await send(side, 'commitActions', [
            id,
            1,
            keccak256(codec.encodeTurn(actionInputs[side])),
          ]);
      for (const side of [0, 1])
        if (phase > p.ROUND_REVEAL || (phase === p.ROUND_REVEAL && mask & (1 << side)))
          await send(side, 'revealActions', [id, 1, actions[side], actionInputs[side].salt]);
    }
    assert.equal((await read('getMatch', [id])).phase, phase, 'Real setup reaches requested stage');
    return { id, squadInputs, actionInputs, actions };
  }
  async function checkTimeout(id, before, phase, mask, sent, label) {
    const outcome = mask === 0 ? 3 : mask === 1 ? 1 : 2;
    const state = { ...before.state, outcome, reason: reason(phase) };
    const hash = keccak256(
      codec.encodeState({ context: context(id), rulesetId: config.rulesetId, state }),
    );
    const after = await snapshot(id, sent.receipt.blockNumber);
    assert.deepEqual(
      after,
      {
        ...before,
        state,
        summary: {
          ...before.summary,
          phase: p.FINISHED,
          phaseDeadline: 0n,
          outcome,
          reason: state.reason,
          stateHash: hash,
        },
      },
      'Timeout preserves all non-result state',
    );
    const logs = events(sent.receipt, ['PhaseAdvanced', 'MatchFinished']);
    assert.deepEqual(logs[0], {
      matchId: id,
      round: before.summary.activeRound,
      fromPhase: phase,
      toPhase: p.FINISHED,
      deadline: 0n,
    });
    assert.deepEqual(logs[1], {
      matchId: id,
      round: before.summary.activeRound,
      winner:
        outcome === 3
          ? '0x0000000000000000000000000000000000000000'
          : accounts[outcome - 1].address,
      battleStarted: state.battleStarted,
      completedRound: state.completedRound,
      outcome,
      reason: state.reason,
      stateHash: hash,
    });
    stateCase(id, state, hash, label);
    evidence.cases.push(
      plain({
        label,
        phase,
        mask,
        matchId: id,
        before,
        after,
        source: {
          hash: sent.receipt.transactionHash,
          blockNumber: sent.receipt.blockNumber,
          blockHash: sent.receipt.blockHash,
        },
      }),
    );
    gas('timeout', sent, label);
    return after;
  }
  async function checkWaiting(id, before, sent, nextPhase, label) {
    const after = await snapshot(id, sent.receipt.blockNumber);
    assert.deepEqual(
      after,
      { ...before, summary: { ...before.summary, phase: nextPhase, phaseDeadline: 0n } },
      'Waiting closure cannot invent a match result',
    );
    const [event] = events(sent.receipt, ['PhaseAdvanced']);
    assert.deepEqual(event, {
      matchId: id,
      round: 0,
      fromPhase: p.WAITING,
      toPhase: nextPhase,
      deadline: 0n,
    });
    evidence.cases.push(
      plain({ label, matchId: id, before, after, hash: sent.receipt.transactionHash }),
    );
    gas(nextPhase === p.CANCELLED ? 'cancel' : 'expiry', sent, label);
    await rejected('joinMatch', [id], 1, 'InvalidPhase');
    await rejected('startMatch', [id], 0, 'InvalidPhase');
    assert.deepEqual(await snapshot(id), after, 'Closed waiting room is immutable');
  }

  for (const phase of [p.SQUAD_COMMIT, p.SQUAD_REVEAL, p.ROUND_COMMIT, p.ROUND_REVEAL])
    for (const mask of [0, 1, 2]) {
      const label = `timeout-phase-${phase}-mask-${mask}`;
      report.stage = `${engine}:${label}`;
      const stage = await setup(phase, mask);
      const { id } = stage;
      const before = await snapshot(id);
      const round = before.summary.activeRound;
      await rejected('advanceExpiredPhase', [id, round, phase], 2, 'DeadlineNotPassed');
      await rejected('advanceExpiredPhase', [id, round + 1, phase], 2, 'StaleRound');
      await clockAfter(before.summary.phaseDeadline);
      const sent = await send(mask === 0 ? 2 : mask === 1 ? 1 : 0, 'advanceExpiredPhase', [
        id,
        round,
        phase,
      ]);
      const after = await checkTimeout(id, before, phase, mask, sent, label);
      await rejected('advanceExpiredPhase', [id, round, phase], 2, 'InvalidPhase');
      const side = mask === 1 ? 1 : 0;
      if (phase === p.SQUAD_COMMIT)
        await rejected('commitSquad', [id, zeroHash], side, 'InvalidPhase');
      else if (phase === p.SQUAD_REVEAL)
        await rejected(
          'revealSquad',
          [id, stage.squadInputs[side].unitTypes, stage.squadInputs[side].salt],
          side,
          'InvalidPhase',
        );
      else if (phase === p.ROUND_COMMIT)
        await rejected('commitActions', [id, round, zeroHash], side, 'InvalidPhase');
      else
        await rejected(
          'revealActions',
          [id, round, stage.actions[side], stage.actionInputs[side].salt],
          side,
          'InvalidPhase',
        );
      assert.deepEqual(
        await snapshot(id),
        after,
        'Late/duplicate calls cannot change terminal state',
      );
    }
  for (const joined of [false, true])
    for (const expired of [false, true]) {
      report.stage = `${engine}:waiting:${joined}:${expired}`;
      const { id } = await setup(p.WAITING, 0, joined);
      const before = await snapshot(id);
      const deadline = before.summary.joinDeadline;
      await rejected('cancelWaitingMatch', [id], 2, 'NotCreator');
      await rejected('expireWaitingMatch', [id], 2, 'DeadlineNotPassed');
      if (expired || joined) await clockAfter(deadline);
      const sent = await send(
        expired ? 2 : 0,
        expired ? 'expireWaitingMatch' : 'cancelWaitingMatch',
        [id],
      );
      await checkWaiting(
        id,
        before,
        sent,
        expired ? p.EXPIRED : p.CANCELLED,
        `waiting-${joined}-${expired}`,
      );
    }

  report.stage = `${engine}:competing-timeout`;
  let stage = await setup(p.ROUND_REVEAL, 1);
  let before = await snapshot(stage.id);
  await clockAfter(before.summary.phaseDeadline);
  let competed = await race(
    [1, 2].map((side) => ({
      side,
      functionName: 'advanceExpiredPhase',
      args: [stage.id, 1, p.ROUND_REVEAL],
    })),
  );
  let winner = competed.find((entry) => entry.receipt.status === 'success');
  await checkTimeout(stage.id, before, p.ROUND_REVEAL, 1, winner, 'competing-timeout');
  evidence.races.push({
    name: 'timeout',
    receipts: competed.map((entry) => ({
      hash: entry.receipt.transactionHash,
      status: entry.receipt.status,
    })),
  });

  report.stage = `${engine}:competing-waiting-closure`;
  stage = await setup(p.WAITING, 0, true);
  before = await snapshot(stage.id);
  await clockAfter(before.summary.joinDeadline);
  competed = await race([
    { side: 0, functionName: 'cancelWaitingMatch', args: [stage.id] },
    { side: 2, functionName: 'expireWaitingMatch', args: [stage.id] },
  ]);
  winner = competed.find((entry) => entry.receipt.status === 'success');
  const closed = await read('getMatch', [stage.id], winner.receipt.blockNumber);
  assert.ok(closed.phase === p.CANCELLED || closed.phase === p.EXPIRED);
  await checkWaiting(stage.id, before, winner, closed.phase, 'competing-waiting-closure');
  evidence.races.push({
    name: 'cancel-expiry',
    receipts: competed.map((entry) => ({
      hash: entry.receipt.transactionHash,
      status: entry.receipt.status,
    })),
  });

  report.stage = `${engine}:competing-settlement`;
  stage = await setup(p.RESOLVABLE, 3);
  before = await snapshot(stage.id);
  await rejected('advanceExpiredPhase', [stage.id, 1, p.RESOLVABLE], 2, 'InvalidTimeoutPhase');
  await clockAfter((await client.getBlock()).timestamp + 86400n);
  competed = await race(
    [0, 2].map((side) => ({ side, functionName: 'settleRound', args: [stage.id, 1] })),
  );
  winner = competed.find((entry) => entry.receipt.status === 'success');
  const after = await snapshot(stage.id, winner.receipt.blockNumber);
  const expectedState = { ...before.state, completedRound: 1 };
  const hash = keccak256(
    codec.encodeState({
      context: context(stage.id),
      rulesetId: config.rulesetId,
      state: expectedState,
    }),
  );
  const emptyTurn = {
    commitments: [zeroHash, zeroHash],
    committed: [false, false],
    revealed: [false, false],
  };
  assert.deepEqual(after, {
    ...before,
    state: expectedState,
    turn: emptyTurn,
    summary: {
      ...before.summary,
      phase: p.ROUND_COMMIT,
      activeRound: 2,
      phaseDeadline: winner.timestamp + 600n,
      stateHash: hash,
    },
  });
  const logs = events(winner.receipt, ['RoundResolved', 'PhaseAdvanced']);
  const effects = {
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
  assert.deepEqual(logs[0], {
    matchId: stage.id,
    round: 1,
    beforeStateHash: before.summary.stateHash,
    afterStateHash: hash,
    state: expectedState,
    effects,
  });
  assert.deepEqual(logs[1], {
    matchId: stage.id,
    round: 2,
    fromPhase: p.RESOLVABLE,
    toPhase: p.ROUND_COMMIT,
    deadline: winner.timestamp + 600n,
  });
  stateCase(stage.id, after.state, hash, 'competing-settlement');
  gas('settle', winner, 'competing-settlement');
  evidence.cases.push(
    plain({
      label: 'competing-settlement',
      matchId: stage.id,
      before,
      after,
      hash: winner.receipt.transactionHash,
    }),
  );
  evidence.races.push({
    name: 'settlement',
    receipts: competed.map((entry) => ({
      hash: entry.receipt.transactionHash,
      status: entry.receipt.status,
    })),
  });
  await clockAfter(after.summary.phaseDeadline);
  await rejected('advanceExpiredPhase', [stage.id, 1, p.ROUND_COMMIT], 2, 'StaleRound');
  const final = await send(2, 'advanceExpiredPhase', [stage.id, 2, p.ROUND_COMMIT]);
  await checkTimeout(stage.id, after, p.ROUND_COMMIT, 0, final, 'post-settlement-timeout');
  assert.equal(evidence.cases.length, 20);
  assert.equal(evidence.races.length, 3);
  assert.equal(evidence.hashedStates, 15);
  evidence.status = 'passed';
  console.log(
    `PASS: ${engine} all four timeout/default matrices, waiting cancellation/expiry, public executor, late/stale rejection, three real competing transaction pairs and preserved completed-round accounting.`,
  );
}
