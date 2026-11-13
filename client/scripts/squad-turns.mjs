import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  zeroHash,
} from 'viem';
import { readJson } from '../../scripts/deployment.mjs';
import { squadOutputType } from './squad-battles.mjs';

const plain = (value) =>
  JSON.parse(
    JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item)),
  );
const gasNames = [
  'commit-first',
  'commit-second',
  'reveal-first',
  'reveal-second',
  'settle-moves',
  'settle-cover-lock',
  'settle-healing',
  'settle-terminal',
];

export const frameType = (config) =>
  `(${config.types.state} initial,${config.types.action}[3][2] actions,${config.types.state} next,${config.types.effects} effects)`;

export async function checkTurnFixtures({ path, run, signal, seed, report, config }) {
  const nativeFile = path('.local/safety/squad-battle-tests.json');
  const gasFile = path('.local/safety/squad-turn-gas-tests.json');
  const snapshot = path('.local/safety/squad-turn-gas.snapshot');
  report.battleNative = { status: 'running' };
  const games = await Promise.all(
    [0, 4, 8].map(async (index) => {
      const [, mapId, frames] = decodeAbiParameters(
        parseAbiParameters(`uint256,uint8,${squadOutputType(config)}[]`),
        (await readFile(path(`.local/simulation/squad-safety/game-${index}.abi`), 'utf8')).trim(),
      );
      return {
        mapId,
        frames: frames.map((frame) => ({
          initial: frame.initial,
          actions: frame.actions,
          next: frame.next,
          effects: frame.effects,
        })),
      };
    }),
  );
  for (const game of games) {
    const types = game.frames[0].initial.units.map((unit) => unit.unitType);
    const corpus = encodeAbiParameters(
      parseAbiParameters('(uint8[3] a,uint8[3] b,bytes[] rounds)'),
      [
        {
          a: types.slice(0, 3),
          b: types.slice(3),
          rounds: game.frames.map((frame) =>
            encodeAbiParameters(parseAbiParameters(`${config.types.action}[3][2]`), [
              frame.actions,
            ]),
          ),
        },
      ],
    );
    await writeFile(
      path(`.local/simulation/squad-rooms/battle-game-${game.mapId}.abi`),
      Buffer.from(corpus.slice(2), 'hex'),
    );
  }
  await Promise.all([
    ...[nativeFile, gasFile, snapshot].map((file) => writeFile(file, '')),
    writeFile(path('.local/simulation/squad-rooms/battle-sequence.abi'), ''),
    ...gasNames.map((name) => writeFile(path(`.local/safety/squad-turn-gas-${name}.json`), '')),
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
    assert.equal(suites.length, 1, 'Dedicated native battle suite');
    return suites.flatMap(([suite, outcome]) => {
      assert.deepEqual(outcome.warnings, [], `${suite}: warnings`);
      return Object.entries(outcome.test_results).map(([name, test]) => {
        assert.equal(test.status, 'Success', `${name}: ${test.reason ?? 'native failure'}`);
        return { suite, name, kind: test.kind };
      });
    });
  }
  report.stage = 'native-battle-protocol';
  const tests = await forge(
    ['test', '--match-contract', '^SquadBattleTest$', '--fuzz-seed', seed, '--fuzz-runs', '64'],
    nativeFile,
  );
  assert.equal(tests.length, 12, 'Complete battle protocol cases');
  const fuzz = tests.filter((test) => test.kind.Fuzz);
  assert.equal(fuzz.length, 1);
  assert.equal(fuzz[0].kind.Fuzz.runs, 64);
  report.battleNative.tests = tests;
  report.battleNative.fuzzRuns = 64;
  report.stage = 'native-turn-gas';
  const gasTests = await forge(
    ['snapshot', '--match-contract', '^SquadTurnGasTest$', '--isolate', '--snap', snapshot],
    gasFile,
  );
  assert.equal(gasTests.length, gasNames.length);
  const samples = await Promise.all(
    gasNames.map((name) => readJson(path(`.local/safety/squad-turn-gas-${name}.json`))),
  );
  for (const [index, sample] of samples.entries()) {
    const name = gasNames[index];
    assert.equal(sample.name, name);
    assert.ok(Number.isInteger(sample.gasUsed) && sample.gasUsed >= 21_000);
    assert.equal(
      sample.target,
      name.startsWith('commit') ? 100_000 : name.startsWith('reveal') ? 250_000 : 1_500_000,
    );
  }
  report.battleNative.gas = {
    scope:
      'Isolated external-call deltas include intrinsic calldata Gas and small fixture overhead; do not add intrinsic Gas again. Actual receipt budgets are checked separately on both nodes.',
    samples,
    snapshot: (await readFile(snapshot, 'utf8')).trim(),
    budgetMisses: samples.filter((sample) => sample.gasUsed >= sample.target),
  };
  for (const sample of report.battleNative.gas.budgetMisses)
    console.error(
      `Gas target missed: native battle ${sample.name}: ${sample.gasUsed}, target<${sample.target}`,
    );
  assert.equal(report.battleNative.gas.budgetMisses.length, 0, 'Battle native Gas budgets');
  report.battleNative.status = 'passed';
  console.log(
    `PASS: battle protocol: ${tests.length} native cases, 64 fuzz executions, eight isolated transaction Gas samples and a reachable twenty-round skill/effect sequence.`,
  );
}

export async function checkSignedTurns(context) {
  const { path, engine, result, report, config } = context;
  assert.equal(report.battleNative.status, 'passed', 'Battle native checks must pass first');
  const framesType = parseAbiParameters(`${frameType(config)}[]`);
  const [frames] = decodeAbiParameters(
    framesType,
    (await readFile(path('.local/simulation/squad-rooms/battle-sequence.abi'), 'utf8')).trim(),
  );
  assert.equal(frames.length, 20);
  const start = result.initializations.find((entry) => entry.state.mapId === 1);
  assert.ok(start, 'The real map-one room supplies the hidden-squad protocol and initial events');
  const battle = (result.battle = {});
  await playSignedRounds({ ...context, start, frames, name: 'battle', battle });
  assert.equal(battle.rounds[3].state.units[3].lockedRound, 5);
  assert.equal(battle.rounds[4].effects.moved[3], true);
  assert.equal(battle.rounds[4].state.units[3].lockedRound, 0);
  assert.equal(battle.rounds[5].effects.moved[3], true);
  battle.coverage.lockedNormalMoves = 1;
  battle.coverage.unlockedDash = 1;
  for (const [name, count] of Object.entries(battle.coverage))
    assert.ok(count > 0, `Actual battle effect missing: ${name}`);
  console.log(
    `PASS: ${engine} battle: twenty signed rounds from the original hidden-squad room, real Medic/Cover/lock effects, locked normal movement, unlocked Dash, event-derived history, once-only terminal result and receipt-pinned state.`,
  );
}

export async function playSignedRounds({
  engine,
  result,
  report,
  config,
  codec,
  accounts,
  read,
  send,
  events,
  hashCases,
  start,
  frames,
  name,
  battle,
}) {
  const id = BigInt(start.context.matchId);
  const context = { ...start.context, chainId: BigInt(start.context.chainId), matchId: id };
  const rulesetId = start.rulesetId;
  const initialSummary = await read('getMatch', [id]);
  const squad = plain(await read('getSquadStatus', [id]));
  let state = start.state;
  let stateHash = start.stateHash;
  const records = [];
  const coverage = {
    healing: 0,
    cover: 0,
    locks: 0,
    deaths: 0,
  };
  Object.assign(battle, {
    status: 'running',
    matchId: id.toString(),
    initialState: start.state,
    initialHash: start.stateHash,
    rounds: records,
    coverage,
  });

  async function inspect(
    blockNumber,
    phase,
    round,
    deadline,
    turn,
    expectedState = state,
    hash = stateHash,
  ) {
    const [summary, actualState, actualTurn, actualSquad] = await Promise.all([
      read('getMatch', [id], blockNumber),
      read('getBattleState', [id], blockNumber),
      read('getRoundStatus', [id], blockNumber),
      read('getSquadStatus', [id], blockNumber),
    ]);
    assert.deepEqual(
      summary,
      {
        ...initialSummary,
        phase,
        activeRound: round,
        phaseDeadline: deadline,
        stateHash: hash,
        outcome: expectedState.outcome,
        reason: expectedState.reason,
      },
      'Receipt-pinned battle summary',
    );
    assert.deepEqual(
      plain(actualState),
      plain(expectedState),
      'Receipt-pinned authoritative state',
    );
    assert.deepEqual(actualTurn, turn, 'Receipt-pinned turn flags and commitments');
    assert.deepEqual(plain(actualSquad), squad, 'Battle must retain original public squads');
  }
  function gas(sent, operation, target, position, round) {
    result.gas.push({
      scope: 'battle',
      operation,
      mapId: 1,
      matchId: id.toString(),
      round,
      position,
      hash: sent.receipt.transactionHash,
      gasUsed: Number(sent.receipt.gasUsed),
      target,
    });
  }
  for (const [index, frame] of frames.entries()) {
    const round = index + 1;
    report.stage = `${engine}:${name}:round-${round}`;
    assert.deepEqual(plain(frame.initial), plain(state), 'Actual sequence continuity');
    const beforeHash = stateHash;
    const salts = accounts.map(() => `0x${randomBytes(32).toString('hex')}`);
    const inputs = accounts.map((account, side) => {
      const own = state.units.slice(side * 3, side * 3 + 3);
      return {
        context,
        player: account.address,
        rulesetId,
        round,
        side,
        unitTypes: own.map((unit) => unit.unitType),
        alive: own.map((unit) => unit.alive),
        lockedRound: own.map((unit) => unit.lockedRound),
        actions: frame.actions[side],
        salt: salts[side],
      };
    });
    const encodings = inputs.map((input) => codec.encodeTurn(input));
    const commitments = encodings.map((encoding) => keccak256(encoding));
    const turn = {
      commitments: [zeroHash, zeroHash],
      committed: [false, false],
      revealed: [false, false],
    };
    let deadline = (await read('getMatch', [id])).phaseDeadline;
    const order = round % 2 === 0 ? [1, 0] : [0, 1];
    for (const [position, side] of order.entries()) {
      const sent = await send(side, 'commitActions', [id, round, commitments[side]]);
      const logs = events(
        sent.receipt,
        position === 0 ? ['ActionCommitted'] : ['ActionCommitted', 'PhaseAdvanced'],
      );
      assert.deepEqual(logs[0], {
        matchId: id,
        round,
        player: accounts[side].address,
        commitment: commitments[side],
      });
      turn.commitments[side] = commitments[side];
      turn.committed[side] = true;
      if (position === 1) {
        deadline = sent.timestamp + BigInt(config.ruleDefinition.windows[4]);
        assert.deepEqual(logs[1], {
          matchId: id,
          round,
          fromPhase: config.phases.ROUND_COMMIT,
          toPhase: config.phases.ROUND_REVEAL,
          deadline,
        });
      }
      await inspect(
        sent.receipt.blockNumber,
        position === 0 ? config.phases.ROUND_COMMIT : config.phases.ROUND_REVEAL,
        round,
        deadline,
        turn,
      );
      gas(sent, 'commit', 100_000, position === 0 ? 'first' : 'second', round);
    }
    const revealed = [];
    for (const [position, side] of [...order].reverse().entries()) {
      const sent = await send(side, 'revealActions', [id, round, frame.actions[side], salts[side]]);
      const logs = events(
        sent.receipt,
        position === 0 ? ['ActionRevealed'] : ['ActionRevealed', 'PhaseAdvanced'],
      );
      assert.deepEqual(logs[0], {
        matchId: id,
        round,
        player: accounts[side].address,
        actions: frame.actions[side],
        salt: salts[side],
      });
      turn.revealed[side] = true;
      if (position === 1) {
        assert.deepEqual(logs[1], {
          matchId: id,
          round,
          fromPhase: config.phases.ROUND_REVEAL,
          toPhase: config.phases.RESOLVABLE,
          deadline: 0n,
        });
      }
      await inspect(
        sent.receipt.blockNumber,
        position === 0 ? config.phases.ROUND_REVEAL : config.phases.RESOLVABLE,
        round,
        position === 0 ? deadline : 0n,
        turn,
      );
      gas(sent, 'reveal', 250_000, position === 0 ? 'first' : 'second', round);
      // Only successfully published Reveal preimages enter retained evidence.
      hashCases.push({
        name: `${engine}:${name}:${round}:side-${side}`,
        kind: 3,
        input: plain(inputs[side]),
        expectedEncoding: encodings[side],
        expectedHash: commitments[side],
      });
      revealed[side] = {
        ...logs[0],
        source: {
          hash: sent.receipt.transactionHash,
          blockNumber: sent.receipt.blockNumber.toString(),
          blockHash: sent.receipt.blockHash,
        },
      };
    }
    const expectedEncoding = codec.encodeState({ context, rulesetId, state: frame.next });
    const afterHash = keccak256(expectedEncoding);
    const sent = await send(round % 2, 'settleRound', [id, round]);
    const finished = frame.next.outcome !== 0;
    const logs = events(
      sent.receipt,
      finished
        ? ['RoundResolved', 'PhaseAdvanced', 'MatchFinished']
        : ['RoundResolved', 'PhaseAdvanced'],
    );
    assert.deepEqual(logs[0], {
      matchId: id,
      round,
      beforeStateHash: beforeHash,
      afterStateHash: afterHash,
      state: frame.next,
      effects: frame.effects,
    });
    const nextPhase = finished ? config.phases.FINISHED : config.phases.ROUND_COMMIT;
    const nextRound = finished ? round : round + 1;
    const nextDeadline = finished ? 0n : sent.timestamp + BigInt(config.ruleDefinition.windows[3]);
    assert.deepEqual(logs[1], {
      matchId: id,
      round: nextRound,
      fromPhase: config.phases.RESOLVABLE,
      toPhase: nextPhase,
      deadline: nextDeadline,
    });
    if (finished) {
      const winner =
        frame.next.outcome === 1
          ? accounts[0].address
          : frame.next.outcome === 2
            ? accounts[1].address
            : '0x0000000000000000000000000000000000000000';
      assert.deepEqual(logs[2], {
        matchId: id,
        round,
        winner,
        battleStarted: true,
        completedRound: frame.next.completedRound,
        outcome: frame.next.outcome,
        reason: frame.next.reason,
        stateHash: afterHash,
      });
    }
    await inspect(
      sent.receipt.blockNumber,
      nextPhase,
      nextRound,
      nextDeadline,
      finished
        ? turn
        : {
            commitments: [zeroHash, zeroHash],
            committed: [false, false],
            revealed: [false, false],
          },
      frame.next,
      afterHash,
    );
    gas(sent, 'settle', 1_500_000, 'settlement', round);
    const effects = logs[0].effects;
    coverage.healing += effects.healed.reduce((sum, value) => sum + value, 0);
    coverage.cover += effects.coverReduced.reduce((sum, value) => sum + value, 0);
    coverage.locks += effects.lockedRoundApplied.filter((value) => value > 0).length;
    coverage.deaths += state.units.filter(
      (unit, unitId) => unit.alive && !frame.next.units[unitId].alive,
    ).length;
    records.push(
      plain({
        round,
        beforeHash,
        afterHash,
        reveals: revealed,
        state: logs[0].state,
        effects,
        resolution: {
          hash: sent.receipt.transactionHash,
          blockNumber: sent.receipt.blockNumber,
          blockHash: sent.receipt.blockHash,
        },
        finished: finished ? logs[2] : undefined,
      }),
    );
    hashCases.push({
      name: `${engine}:${name}:${round}:state`,
      kind: 4,
      input: plain({ context, rulesetId, state: logs[0].state }),
      expectedEncoding,
      expectedHash: afterHash,
    });
    state = plain(logs[0].state);
    stateHash = afterHash;
  }
  assert.equal(
    records.filter((row) => row.finished).length,
    frames.at(-1).next.outcome === 0 ? 0 : 1,
    'Only the expected final frame can finish the match',
  );
  battle.status = 'passed';
  battle.finalStateHash = stateHash;
  return battle;
}
