import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readJson, saveJson } from '../../scripts/deployment.mjs';
import { prepareSquadBaseline } from '../../scripts/squad-baseline.mjs';
import { prepareSquadTypes } from './squad-types.mjs';
import { prepareSquadActions } from './squad-actions.mjs';
import { prepareSquadBattles } from './squad-battles.mjs';

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
const baselineReport = { status: 'running', startedAt: report.startedAt };
const typesReport = { status: 'running', startedAt: report.startedAt };
const actionsReport = { status: 'running', startedAt: report.startedAt };
const battlesReport = { status: 'running', startedAt: report.startedAt };
const computedEncodings = new Map();

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
  if (entry.expectedEncoding)
    assert.equal(actual.encoding, entry.expectedEncoding, `${label}: ABI bytes`);
  else assert.ok(entry.expectedHash, `${label}: a fixed expected hash is required`);
  if (language === 'TypeScript') computedEncodings.set(entry.name, actual.encoding);
  else
    assert.equal(
      actual.encoding,
      computedEncodings.get(entry.name),
      `${label}: cross-language bytes`,
    );
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

async function runSolidityCases(script, directory, entries, viem, options) {
  await mkdir(path(directory), { recursive: true });
  const inputFile = path(`${directory}/input.abi`),
    outputFile = path(`${directory}/output.ndjson`);
  const results = [];
  // Bound the local EVM working set while reusing each runner's compiler cache.
  for (let offset = 0; offset < entries.length; offset += 96) {
    const batch = viem.encodeAbiParameters(
      viem.parseAbiParameters('(uint8 kind,bytes payload)[]'),
      [
        entries
          .slice(offset, offset + 96)
          .map((entry) => ({ kind: entry.kind, payload: entry.payload })),
      ],
    );
    await writeFile(inputFile, Buffer.from(batch.slice(2), 'hex'));
    const forge = await run(
      'forge',
      [
        'script',
        script,
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
        path(`${directory}/artifacts`),
        '--cache-path',
        path(`${directory}/cache.json`),
      ],
      { ...options, cwd: path('contracts') },
    );
    if (forge.stderr.trim()) process.stderr.write(forge.stderr);
    results.push(
      ...(await readFile(outputFile, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    );
  }
  return results;
}

let selector;
try {
  const viem = require('viem');
  const ts = require('typescript');
  selector = viem.toFunctionSelector('InvalidProtocol()');
  const config = await readJson(path('config/squad-protocol.json'));
  const { cases: protocolCases } = await readJson(path('config/squad-protocol-vectors.json'));
  const rules = await readJson(path('config/squad-rules.json'));
  const { maps } = await readJson(path('config/maps.json'));
  const baseline = await prepareSquadBaseline(root, rules, maps, config);
  Object.assign(baselineReport, baseline.report);
  const cases = [...protocolCases, ...baseline.cases];

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
  const types = prepareSquadTypes(config, rules, maps, baseline, generated.squadArenaAbi, viem);
  Object.assign(typesReport, types.report);
  const staticActions = prepareSquadActions(config, rules, maps, baseline, viem);
  Object.assign(actionsReport, staticActions.report);
  const battles = prepareSquadBattles(config, baseline, viem);
  Object.assign(battlesReport, battles.report);
  const codec = loadTypeScript(
    await readFile(path('client/src/lib/squadProtocol.ts'), 'utf8'),
    (name) => (name === '../generated/squadArena' ? generated : require(name)),
  );
  const registry = loadTypeScript(await readFile(path('client/src/lib/rulesets.ts'), 'utf8'));
  const selections = baseline.manifest.selections.map((entry) => {
    try {
      return {
        accepted: true,
        ...registry.selectRuleset(
          baseline.manifest.profiles,
          entry.registered,
          entry.observed,
          entry.capability,
          entry.matchId,
        ),
      };
    } catch (error) {
      if (!(error instanceof registry.RulesetError)) throw error;
      return { accepted: false, error: error.message };
    }
  });
  selections.forEach((actual, index) =>
    assert.deepEqual(
      actual,
      baseline.manifest.selections[index].expected,
      `TypeScript ruleset selection: ${baseline.manifest.selections[index].name}`,
    ),
  );
  baselineReport.typescriptSelections = selections.length;
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
  await mkdir(path('.local/simulation/protocol'), { recursive: true });
  const fixtureFile = path('.local/simulation/protocol/cases.json');
  await writeFile(
    fixtureFile,
    JSON.stringify({
      cases,
      profiles: baseline.manifest.profiles,
      selections: baseline.manifest.selections,
    }),
  );
  report.currentCase = 'Go execution';
  const go = await run(
    'go',
    ['run', '-mod=readonly', './cmd/arena-server', 'check-protocol', fixtureFile],
    {
      ...options,
      cwd: path('server'),
      env: { ...process.env, GOTOOLCHAIN: 'local', GOPROXY: 'off' },
    },
  );
  const goResult = JSON.parse(go.stdout);
  compareBatch(cases, goResult.vectors, 'Go');
  assert.equal(goResult.selections.length, selections.length);
  for (const [index, result] of goResult.selections.entries()) {
    assert.equal(result.name, baseline.manifest.selections[index].name);
    assert.deepEqual(
      result.accepted
        ? { accepted: true, ...result.selection }
        : { accepted: false, error: result.error },
      selections[index],
      `Go ruleset selection: ${result.name}`,
    );
  }
  assert.ok(
    Object.values(goResult.original).every((count) => count > 0),
    'Original vectors must execute',
  );
  baselineReport.goSelections = goResult.selections.length;
  baselineReport.originalGoVectors = goResult.original;
  report.currentCase = 'Solidity execution';
  const solidityCases = [
    ...cases.map((entry, index) => ({ kind: entry.kind, payload: inputs[index] })),
    ...types.cases,
  ];
  const solidityResults = await runSolidityCases(
    'script/CompareSquadProtocol.s.sol:CompareSquadProtocol',
    '.local/simulation/protocol',
    solidityCases,
    viem,
    options,
  );
  assert.equal(solidityResults.length, cases.length + types.cases.length);
  compareBatch(cases, solidityResults.slice(0, cases.length), 'Solidity');
  for (const [index, entry] of types.cases.entries()) {
    report.currentCase = entry.name;
    const actual = solidityResults[cases.length + index];
    assert.equal(actual.accepted, entry.valid, `${entry.name}: accepted`);
    if (entry.valid) {
      assert.equal(
        actual.encoding,
        entry.expectedEncoding,
        `${entry.name}: actual constructed value`,
      );
      if (entry.expectedHash)
        assert.equal(actual.hash, entry.expectedHash, `${entry.name}: ruleset identity`);
    } else assert.equal(actual.rejection, selector, `${entry.name}: explicit protocol rejection`);
    assert.deepEqual(actual.topics ?? [], [], `${entry.name}: no lifecycle events`);
  }
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
  report.currentCase = 'Solidity static validation';
  const actionResults = await runSolidityCases(
    'script/CheckSquadActions.s.sol:CheckSquadActions',
    '.local/simulation/actions',
    staticActions.cases,
    viem,
    options,
  );
  assert.equal(actionResults.length, staticActions.cases.length, 'Static validation result count');
  for (const [index, entry] of staticActions.cases.entries()) {
    report.currentCase = entry.name;
    const actual = actionResults[index];
    assert.equal(actual.accepted, entry.valid, `${entry.name}: static acceptance`);
    if (entry.valid)
      assert.equal(
        actual.encoding,
        entry.expectedEncoding,
        `${entry.name}: result and unchanged inputs`,
      );
    else assert.equal(actual.rejection, selector, `${entry.name}: explicit protocol rejection`);
  }
  Object.assign(actionsReport, { status: 'passed', inputPreservation: 'passed' });
  console.log(
    `PASS: actual Solidity static validation: ${actionsReport.cases} terrain, coordinate, ray and complete-bundle cases; ${actionsReport.legalReferenceBundles} legal reference bundles and ${actionsReport.rejectionReferenceBundles} rejected references. Required costs match and accepted inputs remain unchanged.`,
  );
  report.currentCase = 'Solidity seven-stage resolution';
  const battleResults = await runSolidityCases(
    'script/CheckSquadBattle.s.sol:CheckSquadBattle',
    '.local/simulation/battles',
    battles.cases,
    viem,
    options,
  );
  assert.equal(battleResults.length, battles.cases.length, 'Resolver result count');
  for (const [index, entry] of battles.cases.entries()) {
    report.currentCase = entry.name;
    const actual = battles.compare(entry, battleResults[index], selector);
    if (entry.name.startsWith('reference:')) battlesReport.results.push(actual);
  }
  const altered = structuredClone(battles.cases[0]);
  altered.expected.stages.Support.hp[0]++;
  assert.throws(
    () => battles.compare(altered, battleResults[0], selector),
    (error) => error.difference?.field === `${altered.name}.stages.Support.hp.0`,
    'Altered stage expectation must fail at the affected unit',
  );
  Object.assign(battlesReport, {
    status: 'passed',
    inputPreservation: 'passed',
    arrivalOrder: 'passed',
    ownershipExchange: 'passed',
    invalidBundlesAtomic: 'passed',
    alteredCheckpointRejected: true,
  });
  console.log(
    `PASS: actual Solidity seven-stage resolution: ${battlesReport.frozenRounds} frozen rounds, A-first/B-first and ownership-exchange comparisons, ${battlesReport.rejected} explicit rejections; ${battlesReport.cases} cases. All checkpoints, final states and effects match; inputs remain unchanged.`,
  );
  delete report.currentCase;
  Object.assign(report, {
    status: 'passed',
    rulesetId: config.rulesetId,
    cases: cases.length,
    originalProtocolCases: protocolCases.length,
    baselineCodecCases: baseline.cases.length,
    orderedSquads: squads.length,
    eventSchemas: events.length,
    functionSchemas: functions.length,
    secretIdentities: identities.length,
    deadlineBoundaries: config.deadlineCases.length,
    alteredExpectationRejected: true,
  });
  console.log(
    `PASS: squad protocol: ${squads.length} ordered squads, ${events.length} event schemas, isolated secret keys and deadline boundary data. Live phase transactions and Go gameplay remain later implementation work.`,
  );
  Object.assign(baselineReport, {
    status: 'passed',
    combinedCodecCases: cases.length,
    combinedProtocolLanguages: report.languages,
    metadataSelections: selections.length,
    scope:
      'frozen references, codec agreement, metadata selection and actual Solidity seven-stage reference execution',
    resolverExecution: {
      status: 'passed',
      language: 'Solidity',
      frozenRounds: battlesReport.frozenRounds,
      frozenRejections: battlesReport.frozenRejections,
    },
  });
  console.log(
    `PASS: squad design baseline: ${baselineReport.initializations} map/side/lineup initializations, ${baselineReport.rounds} complete seven-stage references executed by Solidity, ${baselineReport.rejectionReferences} atomic rejection references and ${selections.length} immutable-metadata selections. Independent Go resolution remains later work.`,
  );
  Object.assign(typesReport, {
    status: 'passed',
    matchStorageIsolation: 'passed',
    contractStorageIsolation: 'passed',
  });
  console.log(
    `PASS: actual Solidity squad data: ${typesReport.initializations} constructed states and frozen hashes, ${typesReport.initializationRejections} rejected lineups/maps, ${typesReport.unitNormalizations} unit normalization cases, fixed rules/maps and room/contract/context isolation.`,
  );
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  baselineReport.status = 'failed';
  baselineReport.error = error.message;
  typesReport.status = 'failed';
  typesReport.error = error.message;
  actionsReport.status = 'failed';
  actionsReport.error = error.message;
  if (report.currentCase) actionsReport.currentCase = report.currentCase;
  battlesReport.status = 'failed';
  battlesReport.error = error.message;
  if (report.currentCase) battlesReport.currentCase = report.currentCase;
  if (error.difference) battlesReport.difference = error.difference;
  if (error.expected !== undefined) report.expected = error.expected;
  if (error.actual !== undefined) report.actual = error.actual;
  console.error(
    `FAIL: squad protocol${report.currentCase ? ` (${report.currentCase})` : ''}: ${error.message}`,
  );
  if (error.stdout && report.currentCase !== 'Go execution') process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  baselineReport.completedAt = report.completedAt;
  typesReport.completedAt = report.completedAt;
  actionsReport.completedAt = report.completedAt;
  battlesReport.completedAt = report.completedAt;
  await saveJson(path('.local/design/protocol.json'), report);
  await saveJson(path('.local/design/baseline.json'), baselineReport);
  await saveJson(path('.local/design/types.json'), typesReport);
  await saveJson(path('.local/design/actions.json'), actionsReport);
  await saveJson(path('.local/design/battles.json'), battlesReport);
}
