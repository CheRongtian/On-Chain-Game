import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readJson, saveJson } from '../../scripts/deployment.mjs';

const root = new URL('../../', import.meta.url);
const path = (name) => fileURLToPath(new URL(name, root));
const require = createRequire(new URL('client/package.json', root));
const run = promisify(execFile);
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
const report = {
  status: 'running',
  scope:
    'frozen ABI, canonical encoding, hashes and emitted event bytes; no gameplay or phase transactions',
  languages: {},
  startedAt: new Date().toISOString(),
};

function compare(entry, actual, language) {
  const label = `${language}: ${entry.name}`;
  assert.equal(actual.accepted, entry.valid, `${label}: accepted`);
  if (!entry.valid) {
    assert.equal(
      actual.rejection,
      language === 'Solidity' ? selector : 'InvalidProtocol',
      `${label}: explicit protocol rejection`,
    );
    return;
  }
  assert.equal(actual.encoding, entry.expectedEncoding, `${label}: ABI bytes`);
  if (entry.expectedHash) assert.equal(actual.hash, entry.expectedHash, `${label}: hash`);
  assert.deepEqual(actual.topics ?? [], entry.expectedTopics ?? [], `${label}: event topics`);
}

function compareBatch(cases, results, language) {
  assert.equal(results.length, cases.length, `${language}: result count`);
  for (const [index, entry] of cases.entries()) {
    report.currentCase = `${language}: ${entry.name}`;
    if (results[index].name)
      assert.equal(results[index].name, entry.name, `${language}: case order`);
    compare(entry, results[index], language);
  }
  report.languages[language] = {
    cases: cases.length,
    accepted: cases.filter((entry) => entry.valid).length,
    rejected: cases.filter((entry) => !entry.valid).length,
  };
  console.log(
    `PASS: ${language} squad protocol: ${cases.length} fixed byte/hash/event and rejection cases.`,
  );
}

function canonical(parameter) {
  return parameter.type.startsWith('tuple')
    ? `(${parameter.components.map(canonical).join(',')})${parameter.type.slice(5)}`
    : parameter.type;
}

// Fixture JSON keeps uint256 identifiers as decimal strings, never JS numbers.
function abiValue(parameter, value) {
  const array = parameter.type.match(/^(.*)\[(\d*)\]$/);
  if (array) {
    if (array[2]) assert.equal(value.length, Number(array[2]), 'ABI fixture array length');
    return value.map((item) => abiValue({ ...parameter, type: array[1] }, item));
  }
  if (parameter.type === 'tuple')
    return Object.fromEntries(
      parameter.components.map((child) => [child.name, abiValue(child, value[child.name])]),
    );
  return /^uint(64|128|256)$/.test(parameter.type) ? BigInt(value) : value;
}

function eventArguments(value) {
  return {
    ...value,
    creator: value.player,
    joinDeadline: value.deadline,
    phase: value.toPhase,
    initialState: value.state,
    stateHash: value.afterHash,
    beforeStateHash: value.beforeHash,
    afterStateHash: value.afterHash,
    battleStarted: value.state.battleStarted,
    completedRound: value.state.completedRound,
    outcome: value.state.outcome,
    reason: value.state.reason,
  };
}

let selector;
try {
  const viem = require('viem');
  const ts = require('typescript');
  selector = viem.toFunctionSelector('InvalidProtocol()');
  const config = await readJson(path('config/squad-protocol.json'));
  const { cases } = await readJson(path('config/squad-protocol-vectors.json'));
  const rules = await readJson(path('config/squad-rules.json'));
  const { maps } = await readJson(path('config/maps.json'));

  function loadTypeScript(source, localRequire = require) {
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    });
    const module = { exports: {} };
    new Function('require', 'module', 'exports', outputText)(localRequire, module, module.exports);
    return module.exports;
  }
  const generated = loadTypeScript(
    await readFile(path('client/src/generated/squadArena.ts'), 'utf8'),
  );
  const codec = loadTypeScript(
    await readFile(path('client/src/lib/squadProtocol.ts'), 'utf8'),
    (name) => (name === '../generated/squadArena' ? generated : require(name)),
  );
  assert.equal(config.status, 'protocol-frozen');
  assert.equal(config.runtime, 'codecs-only');
  assert.ok(cases.length > 0);
  assert.equal(new Set(cases.map((entry) => entry.name)).size, cases.length, 'Unique vector names');
  assert.deepEqual(
    config.domains.map((entry) => entry.text),
    codec.domainNames,
  );
  config.domains.forEach((entry, index) =>
    assert.equal(codec.protocolDomain(index), entry.value, 'Frozen domain'),
  );
  assert.equal(
    viem.keccak256(viem.stringToHex(config.semanticsText)),
    config.semanticsId,
    'Reviewed semantics identity',
  );
  const definition = config.ruleDefinition;
  assert.equal(definition.semanticsId, config.semanticsId);
  assert.deepEqual(
    definition.matchRules,
    config.ruleFields.matchRules.map((name) => rules.match[name]),
  );
  assert.deepEqual(
    definition.unitRules,
    rules.units.map((unit) => [
      unit.maxHp,
      unit.moveRange,
      unit.attack.range,
      unit.attack.damage,
      unit.skill.energyCost,
    ]),
  );
  assert.deepEqual(definition.skillRules, [
    rules.units[0].skill.totalDamageReduction,
    rules.units[1].skill.damage,
    rules.units[2].skill.range,
    rules.units[3].skill.range,
    rules.units[3].skill.amount,
    rules.units[4].skill.range,
    rules.units[4].skill.effectiveRoundOffset,
    rules.units[4].skill.durationRounds,
    rules.damage.coverPerSourceReduction,
    rules.damage.coverFloor,
  ]);
  assert.deepEqual(definition.windows, [86400, 600, 600, 600, 600]);
  assert.deepEqual(definition.schemas, [2, 2, 2]);
  assert.deepEqual(
    definition.mapHashes,
    maps.map((map) => map.mapHash),
  );
  assert.deepEqual(cases.find((entry) => entry.name === 'ruleset-definition').input, definition);
  assert.equal(
    viem.keccak256(codec.encodeRules(definition)),
    config.rulesetId,
    'Frozen ruleset ID',
  );
  for (const key of ['context', 'action', 'unit', 'state', 'rules'])
    assert.equal(codec[`${key}Type`], config.types[key], `${key} tuple`);
  assert.deepEqual(config.actionKinds, { HOLD: 0, MOVE: 1, ATTACK: 2, SKILL: 3 });
  assert.deepEqual(config.phases, {
    NONE: 0,
    WAITING: 1,
    SQUAD_COMMIT: 2,
    SQUAD_REVEAL: 3,
    ROUND_COMMIT: 4,
    ROUND_REVEAL: 5,
    RESOLVABLE: 6,
    FINISHED: 7,
    CANCELLED: 8,
    EXPIRED: 9,
  });

  const inputs = cases.map((entry) => {
    if (entry.kind === 0) return viem.encodeAbiParameters([{ type: 'uint8' }], [entry.input]);
    const name = ['rules', 'squadInput', 'actionInput', 'stateInput', 'eventInput'][entry.kind - 1];
    const parameters = viem.parseAbiParameters(config.types[name]);
    return viem.encodeAbiParameters(parameters, [abiValue(parameters[0], entry.input)]);
  });
  const typescriptResults = cases.map((entry) => {
    let input = structuredClone(entry.input);
    if (input.context)
      input.context = {
        ...input.context,
        chainId: BigInt(input.context.chainId),
        matchId: BigInt(input.context.matchId),
      };
    try {
      let encoding;
      if (entry.kind === 0) {
        const hash = codec.protocolDomain(input);
        return {
          accepted: true,
          encoding: viem.encodeAbiParameters([{ type: 'bytes32' }], [hash]),
          hash,
        };
      }
      if (entry.kind === 5) {
        const name = config.events[input.eventType].name;
        const event = generated.squadArenaAbi.find(
          (item) => item.type === 'event' && item.name === name,
        );
        const args = eventArguments(input);
        return {
          accepted: true,
          ...codec.encodeProtocolEvent(
            name,
            Object.fromEntries(
              event.inputs.map((parameter) => [
                parameter.name,
                abiValue(parameter, args[parameter.name]),
              ]),
            ),
          ),
        };
      }
      encoding = [null, codec.encodeRules, codec.encodeSquad, codec.encodeTurn, codec.encodeState][
        entry.kind
      ](input);
      return { accepted: true, encoding, hash: viem.keccak256(encoding) };
    } catch (error) {
      if (!(error instanceof codec.ProtocolError)) throw error;
      return { accepted: false, rejection: 'InvalidProtocol' };
    }
  });
  compareBatch(cases, typescriptResults, 'TypeScript');
  const golden = cases.find((entry) => entry.name === 'squad-1-4-5');
  const actual = typescriptResults[cases.indexOf(golden)];
  assert.throws(
    () => compare({ ...golden, expectedHash: '0x' + '00'.repeat(32) }, actual, 'TypeScript'),
    assert.AssertionError,
    'Changed golden must fail',
  );
  for (const prefix of ['squad-context-', 'actions-context-', 'state-context-']) {
    const hashes = cases
      .filter((entry) => entry.name.startsWith(prefix))
      .map((entry) => entry.expectedHash);
    const base = cases.find(
      (entry) =>
        entry.name ===
        (prefix === 'squad-context-'
          ? 'squad-1-4-5'
          : prefix === 'actions-context-'
            ? 'actions-HOLD'
            : 'state-initial-map-1'),
    ).expectedHash;
    assert.equal(
      new Set([base, ...hashes]).size,
      hashes.length + 1,
      `${prefix}: each changed context has a different hash`,
    );
  }
  const squads = cases.filter((entry) => /^squad-\d-\d-\d$/.test(entry.name));
  assert.equal(squads.length, 60);
  assert.equal(
    new Set(squads.map((entry) => entry.expectedHash)).size,
    60,
    'All ordered squads have distinct commitments',
  );
  const context = {
    ...golden.input.context,
    chainId: BigInt(golden.input.context.chainId),
    matchId: BigInt(golden.input.context.matchId),
  };
  const identity = [
    '0x' + '01'.repeat(32),
    context,
    golden.input.player,
    config.rulesetId,
    'squad',
    0,
  ];
  const identities = [identity];
  identities.push(['0x' + '02'.repeat(32), ...identity.slice(1)]);
  for (const [field, value] of Object.entries({
    chainId: 31338n,
    arena: '0x000000000000000000000000000000000000cafe',
    matchId: 2n,
  }))
    identities.push([identity[0], { ...context, [field]: value }, ...identity.slice(2)]);
  identities.push([
    ...identity.slice(0, 2),
    '0x000000000000000000000000000000000000cafe',
    ...identity.slice(3),
  ]);
  identities.push([...identity.slice(0, 3), '0x' + '02'.repeat(32), ...identity.slice(4)]);
  for (const round of [1, 2]) identities.push([...identity.slice(0, 4), 'actions', round]);
  assert.equal(
    new Set(identities.map((args) => codec.protocolSecretKey(...args))).size,
    identities.length,
    'Secret deployment/context/purpose isolation',
  );
  const mixedCase = { ...context, arena: context.arena.toUpperCase().replace('0X', '0x') };
  assert.equal(
    codec.protocolSecretKey(...identity),
    codec.protocolSecretKey(identity[0], mixedCase, ...identity.slice(2)),
    'Address case normalization',
  );
  assert.throws(
    () => codec.protocolSecretKey(...identity.slice(0, 4), 'squad', 1),
    codec.ProtocolError,
  );
  assert.throws(
    () => codec.protocolSecretKey(...identity.slice(0, 4), 'actions', 0),
    codec.ProtocolError,
  );
  assert.deepEqual(
    config.deadlineCases.map((entry) => entry.name),
    ['before-deadline', 'at-deadline', 'after-deadline'],
  );
  for (const entry of config.deadlineCases)
    assert.deepEqual(
      { submit: entry.now <= entry.deadline, timeout: entry.now > entry.deadline },
      entry.expected,
      entry.name,
    );

  const options = { maxBuffer: 8 * 1024 * 1024, signal: abort.signal };
  report.currentCase = 'Go execution';
  const go = await run('go', ['run', '-mod=readonly', './cmd/arena-server', 'check-protocol'], {
    ...options,
    cwd: path('server'),
    env: { ...process.env, GOTOOLCHAIN: 'local', GOPROXY: 'off' },
  });
  compareBatch(cases, JSON.parse(go.stdout), 'Go');
  await mkdir(path('.local/simulation/protocol'), { recursive: true });
  const batch = viem.encodeAbiParameters(viem.parseAbiParameters('(uint8 kind,bytes payload)[]'), [
    cases.map((entry, index) => ({ kind: entry.kind, payload: inputs[index] })),
  ]);
  const inputFile = path('.local/simulation/protocol/input.abi');
  const outputFile = path('.local/simulation/protocol/output.ndjson');
  await writeFile(inputFile, Buffer.from(batch.slice(2), 'hex'));
  report.currentCase = 'Solidity execution';
  const forge = await run(
    'forge',
    [
      'script',
      'script/CompareSquadProtocol.s.sol:CompareSquadProtocol',
      '--sig',
      'run(string,string)',
      inputFile,
      outputFile,
      '--use',
      path('.local/bin/solc-0.8.30'),
      '--offline',
      '--ast',
      '--disable-external-identification',
      '--out',
      path('.local/simulation/protocol/artifacts'),
      '--cache-path',
      path('.local/simulation/protocol/cache.json'),
    ],
    { ...options, cwd: path('contracts') },
  );
  if (forge.stderr.trim()) process.stderr.write(forge.stderr);
  compareBatch(
    cases,
    (await readFile(outputFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    'Solidity',
  );
  const artifact = await readJson(
    path('.local/simulation/protocol/artifacts/ISquadArena.sol/ISquadArena.json'),
  );
  const abi = JSON.parse(artifact.rawMetadata).output.abi;
  assert.deepEqual(generated.squadArenaAbi, abi, 'Generated browser ABI matches compiler');
  const events = abi.filter((item) => item.type === 'event');
  assert.equal(events.length, config.events.length);
  for (const frozen of config.events) {
    const event = events.find((item) => item.name === frozen.name);
    assert.equal(
      `${event.name}(${event.inputs.map(canonical).join(',')})`,
      frozen.signature,
      `${event.name}: signature`,
    );
    assert.deepEqual(
      event.inputs.filter((item) => item.indexed).map((item) => item.name),
      frozen.indexed,
      `${event.name}: indexed fields`,
    );
    assert.equal(viem.toEventSelector(event), frozen.topic, `${event.name}: topic zero`);
    if (['SquadCommitted', 'ActionCommitted'].includes(event.name))
      assert.deepEqual(
        event.inputs.filter((item) => !item.indexed).map((item) => item.name),
        ['commitment'],
        `${event.name}: no hidden data`,
      );
  }
  const functions = abi.filter((item) => item.type === 'function');
  assert.equal(functions.length, config.functions.length);
  for (const frozen of config.functions) {
    const fn = functions.find((item) => item.name === frozen.name);
    assert.equal(`${fn.name}(${fn.inputs.map(canonical).join(',')})`, frozen.signature);
    assert.equal(viem.toFunctionSelector(fn), frozen.selector, `${fn.name}: selector`);
  }
  delete report.currentCase;
  Object.assign(report, {
    status: 'passed',
    rulesetId: config.rulesetId,
    cases: cases.length,
    orderedSquads: squads.length,
    eventSchemas: events.length,
    functionSchemas: functions.length,
    secretIdentities: identities.length,
    deadlineBoundaries: config.deadlineCases.length,
    alteredExpectationRejected: true,
  });
  console.log(
    `PASS: squad protocol: ${squads.length} ordered squads, ${events.length} event schemas, isolated secret keys and deadline boundary data. Phase transactions and gameplay remain later implementation work.`,
  );
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  if (error.expected !== undefined) report.expected = error.expected;
  if (error.actual !== undefined) report.actual = error.actual;
  console.error(
    `FAIL: squad protocol${report.currentCase ? ` (${report.currentCase})` : ''}: ${error.message}`,
  );
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await saveJson(path('.local/design/protocol.json'), report);
}
