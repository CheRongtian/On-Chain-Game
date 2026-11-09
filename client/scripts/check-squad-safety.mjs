import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readJson, saveJson } from '../../scripts/deployment.mjs';
import { traceType, squadOutputType } from './squad-battles.mjs';
import { runtimeStateCases } from './squad-hashes.mjs';

const root = new URL('../../', import.meta.url);
const path = (name) => fileURLToPath(new URL(name, root));
const require = createRequire(new URL('client/package.json', root));
const run = promisify(execFile);
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
const evidence = '.local/safety';
const simulation = '.local/simulation/squad-safety';
const report = {
  status: 'running',
  startedAt: new Date().toISOString(),
  scope:
    'new pure squad rules: native unit/fuzz/stateful invariants, fixed vectors, generated games, state encoding and measured kernel Gas; phase/storage transactions and independent Go resolution remain later work',
  seed: '0x20261109',
};
const options = { maxBuffer: 16 * 1024 * 1024, signal: abort.signal };
let failingFrame;
const gasNames = [
  'six-moves-Arena',
  'six-moves-Ruins',
  'six-moves-Crossroads',
  'cover-shield-map-1',
  'cover-shield-map-2',
  'cover-shield-map-3',
  'Scout-four-step-Dash',
  'round-cap-new-lock-21',
  'resource-cap-central-victory',
  'dying-lock-caster',
  'healing-before-lethal-damage',
  'six-skills',
  'six-attacks-and-deaths',
];

async function forge(args) {
  const result = await run(
    'forge',
    [...args, '--offline', '--use', path('.local/bin/solc-0.8.30')],
    {
      ...options,
      cwd: path('contracts'),
      env: { ...process.env, FOUNDRY_INVARIANT_RUNS: '64', FOUNDRY_INVARIANT_DEPTH: '128' },
    },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function nativeResults(suites) {
  return Object.entries(suites).flatMap(([suite, result]) => {
    assert.deepEqual(result.warnings, [], `${suite}: Foundry warnings`);
    return Object.entries(result.test_results).map(([name, value]) => {
      assert.equal(value.status, 'Success', `${suite}.${name}: ${value.reason ?? 'test failed'}`);
      return { suite, name, kind: value.kind };
    });
  });
}

try {
  await mkdir(path(evidence), { recursive: true });
  await mkdir(path(simulation), { recursive: true });
  await saveJson(path(`${evidence}/squad.json`), report);
  // Clear only this campaign's generated outputs so an unwritten file cannot reuse older evidence.
  await Promise.all([
    ...Array.from({ length: 12 }, (_, index) =>
      writeFile(path(`${simulation}/game-${index}.abi`), ''),
    ),
    ...gasNames.map((name) => writeFile(path(`${evidence}/squad-gas-${name}.json`), '')),
    ...['squad-tests.json', 'squad-gas-tests.json', 'squad-coverage.json'].map((name) =>
      writeFile(path(`${evidence}/${name}`), '{}\n'),
    ),
    writeFile(path(`${evidence}/squad-gas.snapshot`), ''),
    writeFile(path(`${simulation}/failure-witness.abi`), ''),
  ]);
  const viem = require('viem');
  const config = await readJson(path('config/squad-protocol.json'));
  const baseline = await readJson(path('config/squad-battle-vectors.json'));
  const edges = await readJson(path('config/squad-skill-vectors.json'));
  const type = viem.parseAbiParameters(
    `(string name,bool valid,${config.types.context} context,${config.types.state} initial,${config.types.action}[3][2] actions,${config.types.state} expected,${config.types.effects} effects,${traceType} trace,bool hasTrace,bytes32 beforeHash,bytes32 stateHash)[]`,
  );
  const vectors = [...baseline.rounds, ...edges.rounds, ...baseline.rejections].map((row) => ({
    name: row.name,
    valid: !row.expected.rejectAt,
    context: {
      ...row.input.context,
      chainId: BigInt(row.input.context.chainId),
      matchId: BigInt(row.input.context.matchId),
    },
    initial: row.input.state,
    actions: row.input.actions,
    expected: row.expected.state,
    effects: row.expected.effects,
    trace: row.expected.stages
      ? {
          positions: row.expected.stages.Movement.positions,
          supportHp: row.expected.stages.Support.hp,
          shields: row.expected.stages.Support.shield,
          rawDamage: row.expected.stages.Damage.rawDamage,
          damageHp: row.expected.stages.Damage.hp,
          activeRound: row.expected.stages.Finalize.activeRound,
        }
      : {
          positions: Array(6).fill(0),
          supportHp: Array(6).fill(0),
          shields: Array(6).fill(0),
          rawDamage: Array(6).fill(0),
          damageHp: Array(6).fill(0),
          activeRound: 0,
        },
    hasTrace: Boolean(row.expected.stages),
    beforeHash: row.expected.beforeStateHash ?? row.expected.stateHash,
    stateHash: row.expected.stateHash,
  }));
  assert.equal(vectors.length, 103, 'Frozen Foundry rule corpus');
  await writeFile(
    path(`${simulation}/references.abi`),
    Buffer.from(viem.encodeAbiParameters(type, [vectors]).slice(2), 'hex'),
  );
  report.stage = 'native-rule-safety';
  console.log(
    'Running dedicated squad rule unit/fuzz tests and stateful invariants with saved seed 0x20261109...',
  );
  await forge([
    'test',
    '--match-contract',
    '^SquadRule(Safety|Invariant)Test$',
    '--fuzz-seed',
    report.seed,
    '--fuzz-runs',
    '64',
    '--json-file',
    path(`${evidence}/squad-tests.json`),
    '-vv',
  ]);
  report.stage = 'native-rule-gas';
  console.log(
    'Recording isolated squad kernel pressure snapshots; complete protocol transaction Gas remains later work...',
  );
  await forge([
    'snapshot',
    '--match-contract',
    '^SquadRuleGasTest$',
    '--isolate',
    '--snap',
    path(`${evidence}/squad-gas.snapshot`),
    '--json-file',
    path(`${evidence}/squad-gas-tests.json`),
    '-vv',
  ]);
  const tests = nativeResults(await readJson(path(`${evidence}/squad-tests.json`)));
  const gasTests = nativeResults(await readJson(path(`${evidence}/squad-gas-tests.json`)));
  assert.equal(tests.length, 11, 'Dedicated native safety test count');
  assert.equal(gasTests.length, 13, 'Dedicated pressure snapshot test count');
  const fuzz = tests.filter((test) => test.kind.Fuzz);
  assert.equal(fuzz.length, 4, 'Snapshot, action, state and complete-game fuzz families');
  fuzz.forEach((test) => assert.equal(test.kind.Fuzz.runs, 64, `${test.name}: fuzz runs`));
  const invariants = tests.filter((test) => test.kind.Invariant);
  assert.equal(invariants.length, 1, 'Stateful rule invariant');
  const invariant = invariants[0].kind.Invariant;
  assert.equal(invariant.runs, 64, 'Invariant runs');
  assert.equal(invariant.calls, 8192, 'Invariant steps');
  assert.equal(invariant.reverts, 0, 'Unexpected handler reverts');
  const metrics = Object.entries(invariant.metrics);
  assert.equal(metrics.length, 1, 'Only the rule handler is targeted');
  assert.ok(metrics[0][0].endsWith('SquadRuleHandler.step'));
  assert.equal(metrics[0][1].calls, invariant.calls);
  assert.equal(metrics[0][1].discards, 0, 'No discarded invariant steps');
  const coverage = await readJson(path(`${evidence}/squad-coverage.json`));
  assert.equal(coverage.status, 'passed');
  assert.equal(coverage.steps, 128);
  for (const key of [
    'games',
    'settlements',
    'moves',
    'healing',
    'damage',
    'locks',
    'deaths',
    'terminals',
    'rejections',
  ])
    assert.ok(coverage[key] > 0, `Nonvacuous ${key}`);
  report.native = {
    tests,
    fuzzRuns: fuzz.reduce((sum, test) => sum + test.kind.Fuzz.runs, 0),
    invariant,
    coverage,
    frozenCases: vectors.length,
  };

  report.stage = 'generated-game-encoding';
  console.log(
    'Checking twelve actual seeded games and independently reproducing every generated state encoding/hash...',
  );
  const gameType = viem.parseAbiParameters(`uint256,uint8,${squadOutputType(config)}[]`);
  const witness = viem.decodeErrorResult({
    abi: viem.parseAbi(['error RuleSafetyFailure(string field,uint256 index,bytes frame)']),
    data: (await readFile(path(`${simulation}/failure-witness.abi`), 'utf8')).trim(),
  });
  assert.equal(witness.args[0], 'Damage accounting differs');
  assert.equal(witness.args[1], 0n);
  const [witnessFrame] = viem.decodeAbiParameters(
    viem.parseAbiParameters(squadOutputType(config)),
    witness.args[2],
  );
  assert.equal(witnessFrame.initial.completedRound, 0);
  assert.equal(witnessFrame.next.completedRound, 1);
  assert.equal(witnessFrame.actions[0][0].actionType, 0);
  assert.equal(witnessFrame.trace.damageHp[0] + 1, witnessFrame.next.units[0].hp);
  report.failureEvidence = { negativeControl: 'passed', field: witness.args[0], unitId: 0 };
  const seeds = ['0', '42', '2026', '8675309'];
  const frames = [];
  const games = [];
  for (let index = 0; index < 12; index++) {
    const [seed, mapId, outputs] = viem.decodeAbiParameters(
      gameType,
      (await readFile(path(`${simulation}/game-${index}.abi`), 'utf8')).trim(),
    );
    assert.equal(seed.toString(), seeds[index % seeds.length]);
    assert.equal(mapId, 1 + Math.floor(index / seeds.length));
    assert.ok(outputs.length > 0 && outputs.length <= 20, 'Bounded generated game');
    for (const [round, output] of outputs.entries()) {
      failingFrame = { mapId, seed: seed.toString(), round: round + 1, output };
      assert.equal(output.initial.mapId, mapId);
      assert.equal(output.initial.completedRound, round);
      assert.equal(output.initial.outcome, 0);
      assert.equal(output.next.completedRound, round + 1);
      if (round) {
        assert.deepEqual(output.initial, outputs[round - 1].next, 'Actual state continuity');
        assert.equal(output.beforeHash, outputs[round - 1].stateHash, 'Actual hash continuity');
        assert.equal(
          output.beforeEncoding,
          outputs[round - 1].afterEncoding,
          'Actual byte continuity',
        );
      }
      frames.push({
        name: `map-${mapId}:seed-${seed}:round-${round + 1}`,
        context: baseline.context,
        initial: output.initial,
        state: output.next,
        beforeEncoding: output.beforeEncoding,
        afterEncoding: output.afterEncoding,
        beforeHash: output.beforeHash,
        stateHash: output.stateHash,
      });
    }
    assert.notEqual(outputs.at(-1).next.outcome, 0, 'Generated game must finish');
    games.push({
      seed: seed.toString(),
      mapId,
      rounds: outputs.length,
      frames: outputs.map((output) => ({
        initial: output.initial,
        actions: output.actions,
        state: output.next,
        effects: output.effects,
        trace: output.trace,
        beforeHash: output.beforeHash,
        stateHash: output.stateHash,
      })),
    });
  }
  const hashCases = runtimeStateCases(frames, config.rulesetId);
  const ts = require('typescript');
  function load(source, localRequire = require) {
    const module = { exports: {} };
    new Function(
      'require',
      'module',
      'exports',
      ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText,
    )(localRequire, module, module.exports);
    return module.exports;
  }
  const generated = load(await readFile(path('client/src/generated/squadArena.ts'), 'utf8'));
  const codec = load(await readFile(path('client/src/lib/squadProtocol.ts'), 'utf8'), (name) =>
    name === '../generated/squadArena' ? generated : require(name),
  );
  for (const entry of hashCases) {
    failingFrame = { state: entry };
    const input = structuredClone(entry.input);
    input.context.chainId = BigInt(input.context.chainId);
    input.context.matchId = BigInt(input.context.matchId);
    const bytes = codec.encodeState(input);
    assert.equal(bytes, entry.expectedEncoding, `${entry.name}: TypeScript bytes`);
    assert.equal(viem.keccak256(bytes), entry.expectedHash, `${entry.name}: TypeScript hash`);
  }
  const stateFile = path(`${simulation}/generated-states.json`);
  await writeFile(stateFile, JSON.stringify({ cases: hashCases }));
  failingFrame = undefined;
  const go = await run(
    'go',
    ['run', '-mod=readonly', './cmd/arena-server', 'check-protocol', stateFile],
    {
      ...options,
      cwd: path('server'),
      env: { ...process.env, GOTOOLCHAIN: 'local', GOPROXY: 'off' },
    },
  );
  const independent = JSON.parse(go.stdout).vectors;
  assert.equal(independent.length, hashCases.length);
  independent.forEach((actual, index) => {
    const expected = hashCases[index];
    failingFrame = { state: expected, actual };
    assert.equal(actual.name, expected.name);
    assert.equal(actual.accepted, true, `${expected.name}: independent Go state`);
    assert.equal(actual.encoding, expected.expectedEncoding, `${expected.name}: Go bytes`);
    assert.equal(actual.hash, expected.expectedHash, `${expected.name}: Go hash`);
  });
  report.generated = {
    games,
    rounds: frames.length,
    stateEncodings: hashCases.length,
    languages: ['Solidity', 'Go', 'TypeScript'],
    independentGoResolution: 'not implemented in this stage',
  };
  failingFrame = undefined;

  report.stage = 'kernel-gas-evidence';
  const gas = [];
  for (const name of gasNames) {
    const sample = await readJson(path(`${evidence}/squad-gas-${name}.json`));
    assert.equal(sample.name, name);
    for (const field of ['fixtureCallGas', 'resolveGas', 'hashGas'])
      assert.ok(Number.isInteger(sample[field]) && sample[field] > 0, `${name}: measured ${field}`);
    assert.equal(sample.initialSettlementTarget, 2_000_000);
    assert.ok(
      sample.fixtureCallGas >= sample.resolveGas + sample.hashGas,
      `${name}: inconsistent Gas intervals`,
    );
    gas.push(sample);
  }
  const snapshot = await readFile(path(`${evidence}/squad-gas.snapshot`), 'utf8');
  assert.equal(snapshot.trim().split('\n').length, gasTests.length, 'Complete Foundry snapshot');
  const maxima = Object.fromEntries(
    ['fixtureCallGas', 'resolveGas', 'hashGas'].map((field) => {
      const sample = gas.reduce((a, b) => (a[field] >= b[field] ? a : b));
      return [field, { value: sample[field], sample: sample.name }];
    }),
  );
  const previous = await readJson(path('.local/design/edges.json'));
  assert.equal(previous.status, 'passed', 'Skill/lifecycle/hash baseline must pass');
  report.gas = {
    scope:
      'isolated kernel fixture calls and separate internal resolve/hash windows; fixture calls include ABI dispatch/encoding and extra proof hashes. The initial 2M target gates internal resolve+hash as a necessary kernel condition only. Complete settlement transaction intrinsic Gas, authoritative storage and production events remain pending protocol integration. These are sampled pressure maxima, not exhaustive upper bounds.',
    compiler: previous.gas.compiler,
    optimizer: previous.gas.optimizer,
    evmVersion: previous.gas.evmVersion,
    samples: gas,
    maxima,
    priorPureCallSamples: previous.gas.summary,
    snapshot,
    nativeTests: gasTests,
    budgetMisses: gas.filter(
      (sample) => sample.resolveGas + sample.hashGas >= sample.initialSettlementTarget,
    ),
    completeTransactionGas: 'pending protocol integration',
  };
  for (const sample of report.gas.budgetMisses)
    console.error(
      `Gas target missed: ${sample.name}: kernel/hash=${sample.resolveGas + sample.hashGas}, target<${sample.initialSettlementTarget}`,
    );
  assert.equal(report.gas.budgetMisses.length, 0, 'Kernel/hash settlement target misses');
  report.status = 'passed';
  delete report.stage;
  console.log(
    `PASS: new squad rule safety: ${tests.length} native tests, ${report.native.fuzzRuns} fuzz cases, ${invariant.calls} stateful calls with zero handler reverts, ${games.length} complete generated games/${frames.length} rounds and ${gas.length} isolated pressure snapshots.`,
  );
  console.log(
    `PASS: generated state encodings/hashes agree in three languages for ${hashCases.length} states; pressure fixture maximum=${maxima.fixtureCallGas.value}, pure resolve maximum=${maxima.resolveGas.value}, hash maximum=${maxima.hashGas.value} Gas. Complete protocol transaction Gas remains later work.`,
  );
} catch (error) {
  report.status = 'failed';
  report.error = error.message.split('\n')[0];
  const nativeFailures = [];
  for (const name of ['squad-tests.json', 'squad-gas-tests.json']) {
    const suites = await readJson(path(`${evidence}/${name}`)).catch(() => ({}));
    for (const [suite, result] of Object.entries(suites))
      for (const [test, value] of Object.entries(result.test_results ?? {}))
        if (value.status !== 'Success') nativeFailures.push({ suite, test, ...value });
  }
  const failureDir = `${evidence}/squad-failures`;
  await mkdir(path(failureDir), { recursive: true });
  report.failure = `${failureDir}/${new Date().toISOString().replaceAll(':', '-')}.json`;
  await writeFile(
    path(report.failure),
    JSON.stringify(
      {
        seed: report.seed,
        stage: report.stage,
        error: report.error,
        nativeFailures,
        frame: failingFrame,
        decoding: {
          errors: [
            'error RuleCallFailure(string expectation,bytes input,bytes result)',
            'error RuleSafetyFailure(string field,uint256 index,bytes frame)',
          ],
          input: '(Context context,State state,Action[3][2] actions)',
          frame: 'SquadBattleProbe.Output in contracts/script/CheckSquadBattle.s.sol',
        },
      },
      (_, value) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    ) + '\n',
  );
  console.error(`FAIL: squad safety (${report.stage ?? 'preparation'}): ${report.error}`);
  if (error.stdout && report.stage !== 'generated-game-encoding')
    process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await saveJson(path(`${evidence}/squad.json`), report);
}
