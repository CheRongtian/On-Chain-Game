import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbiParameters,
  toFunctionSelector,
  zeroHash,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { readJson, runtimeCode, saveJson } from '../../scripts/deployment.mjs';
import { initialState } from '../../scripts/squad-baseline.mjs';
import { checkTurnFixtures, checkSignedTurns } from './squad-turns.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const path = (name) => resolve(root, name);
const require = createRequire(new URL('../package.json', import.meta.url));
assert.equal(
  process.env.ARENA_TEST_PROJECT_ROOT,
  root.replace(/\/$/, ''),
  'Squad room acceptance requires the isolated test workspace.',
);
const file = path('.local/safety/squad-rooms.json');
const publishedFile = path('client/public/deployment.json');
const published = await readFile(publishedFile, 'utf8');
const deployment = JSON.parse(published);
const engine = deployment.engine ?? 'anvil';
assert.ok(engine === 'anvil' || engine === 'geth', 'Supported managed chain');
const report =
  engine === 'anvil'
    ? { status: 'running', startedAt: new Date().toISOString(), seed: '0x20261110', engines: {} }
    : await readJson(file);
const run = promisify(execFile);
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
const plain = (value) =>
  JSON.parse(
    JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item)),
  );
const result = {
  status: 'running',
  engine,
  receipts: [],
  maps: [],
  initializations: [],
  gas: [],
  budgetMisses: [],
};

try {
  if (engine === 'geth')
    assert.equal(report.engines.anvil.status, 'passed', 'Anvil room acceptance must precede Geth');
  report.status = 'running';
  report.stage = `${engine}:preparation`;
  report.engines[engine] = result;
  await saveJson(file, report);
  const config = await readJson(path('config/squad-protocol.json'));
  const rules = await readJson(path('config/squad-rules.json'));
  const { maps } = await readJson(path('config/maps.json'));
  const simulation = path('.local/simulation/squad-rooms');
  await mkdir(simulation, { recursive: true });
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
  const hashCases = [];
  if (engine === 'anvil') {
    await mkdir(path('.local/safety'), { recursive: true });
    const nativeFile = path('.local/safety/squad-room-tests.json');
    await writeFile(nativeFile, '{}\n');
    const vectors = await readJson(path('config/squad-battle-vectors.json'));
    assert.equal(vectors.initializations.length, 360);
    const referenceType = parseAbiParameters(
      `${config.types.context},(string name,uint8 side,${config.types.state} expected,bytes32 stateHash)[]`,
    );
    const corpus = encodeAbiParameters(referenceType, [
      {
        ...vectors.context,
        chainId: BigInt(vectors.context.chainId),
        matchId: BigInt(vectors.context.matchId),
      },
      vectors.initializations.map((row) => ({
        name: row.name,
        side: row.side,
        expected: initialState(row, rules, maps),
        stateHash: row.stateHash,
      })),
    ]);
    await writeFile(
      resolve(simulation, 'initializations.abi'),
      Buffer.from(corpus.slice(2), 'hex'),
    );
    report.stage = 'native-room-protocol';
    console.log(
      'Checking rooms, manual host start, immutable commits, Reveal rollback/privacy, all ordered initialization references and context isolation...',
    );
    const native = await run(
      'forge',
      [
        'test',
        '--match-contract',
        '^Squad(Room|Reveal)Test$',
        '--fuzz-seed',
        report.seed,
        '--fuzz-runs',
        '64',
        '--json-file',
        nativeFile,
        '-vv',
        '--offline',
        '--use',
        path('.local/bin/solc-0.8.30'),
      ],
      { cwd: path('contracts'), signal: abort.signal, maxBuffer: 8 * 1024 * 1024 },
    );
    process.stdout.write(native.stdout);
    if (native.stderr) process.stderr.write(native.stderr);
    const suites = Object.entries(await readJson(nativeFile));
    assert.equal(suites.length, 2, 'Room and Reveal suites');
    const tests = suites.flatMap(([suite, outcome]) => {
      assert.deepEqual(outcome.warnings, [], `${suite}: warnings`);
      return Object.entries(outcome.test_results).map(([name, test]) => {
        assert.equal(test.status, 'Success', `${name}: ${test.reason ?? 'native test failed'}`);
        return { suite, name, kind: test.kind };
      });
    });
    assert.equal(tests.length, 21, 'Complete room and Reveal protocol cases');
    const fuzz = tests.filter((test) => test.kind.Fuzz);
    assert.equal(fuzz.length, 2, 'Commit and Reveal fuzz targets');
    fuzz.forEach((test) => assert.equal(test.kind.Fuzz.runs, 64));
    report.native = { status: 'passed', tests, fuzzRuns: 128, frozenInitializations: 360 };
    report.stage = 'native-reveal-gas';
    const snapshot = path('.local/safety/squad-reveal-gas.snapshot');
    const gasFile = path('.local/safety/squad-reveal-gas-tests.json');
    await Promise.all([
      writeFile(snapshot, ''),
      writeFile(gasFile, '{}\n'),
      ...['first', 'second'].map((position) =>
        writeFile(path(`.local/safety/squad-reveal-gas-${position}.json`), ''),
      ),
    ]);
    const gasRun = await run(
      'forge',
      [
        'snapshot',
        '--match-contract',
        '^SquadRevealGasTest$',
        '--isolate',
        '--snap',
        snapshot,
        '--json-file',
        gasFile,
        '-vv',
        '--offline',
        '--use',
        path('.local/bin/solc-0.8.30'),
      ],
      { cwd: path('contracts'), signal: abort.signal, maxBuffer: 8 * 1024 * 1024 },
    );
    process.stdout.write(gasRun.stdout);
    if (gasRun.stderr) process.stderr.write(gasRun.stderr);
    const gasSuites = Object.values(await readJson(gasFile));
    assert.equal(gasSuites.length, 1);
    assert.deepEqual(gasSuites[0].warnings, []);
    assert.equal(Object.keys(gasSuites[0].test_results).length, 2);
    for (const test of Object.values(gasSuites[0].test_results))
      assert.equal(test.status, 'Success');
    const samples = await Promise.all(
      ['first', 'second'].map((position) =>
        readJson(path(`.local/safety/squad-reveal-gas-${position}.json`)),
      ),
    );
    for (const [index, sample] of samples.entries()) {
      assert.equal(sample.position, ['first', 'second'][index]);
      assert.ok(
        Number.isInteger(sample.isolatedTransactionGas) && sample.isolatedTransactionGas > 0,
      );
      assert.ok(
        sample.intrinsicIncluded >= 21_000 &&
          sample.intrinsicIncluded < sample.isolatedTransactionGas,
      );
      assert.equal(sample.target, 250_000);
    }
    report.nativeGas = {
      scope:
        'Foundry isolated-transaction gasleft deltas include intrinsic calldata Gas and small fixture call overhead. Intrinsic Gas is recorded as an included component and is not added again; actual receipts are checked on both nodes.',
      samples,
      budgetMisses: samples.filter((sample) => sample.isolatedTransactionGas >= sample.target),
      snapshot: await readFile(snapshot, 'utf8'),
    };
    for (const sample of report.nativeGas.budgetMisses)
      console.error(
        `Gas target missed: native ${sample.position} Squad Reveal: ${sample.isolatedTransactionGas}, target<${sample.target}`,
      );
    assert.equal(report.nativeGas.budgetMisses.length, 0, 'Native Reveal Gas targets');
    report.nativeGas.status = 'passed';
    await checkTurnFixtures({ path, run, signal: abort.signal, seed: report.seed, report, config });
  }
  assert.equal(report.native.status, 'passed');
  assert.equal(report.nativeGas.status, 'passed');
  assert.equal(report.battleNative.status, 'passed');
  const artifact = await readJson(path('contracts/out/SquadArena.sol/SquadArena.json'));
  const frozenInterface = await readJson(path('contracts/out/ISquadArena.sol/ISquadArena.json'));
  const { abi } = artifact;
  const methods = abi.filter((entry) => entry.type === 'function');
  assert.equal(methods.length, 16, 'Implemented room, squad, battle and metadata entries');
  assert.ok(
    (artifact.deployedBytecode.object.length - 2) / 2 <= 24_576,
    'SquadArena runtime fits EIP-170',
  );
  for (const method of methods) {
    const frozen = frozenInterface.abi.find(
      (entry) => entry.type === 'function' && entry.name === method.name,
    );
    assert.ok(frozen, `${method.name}: frozen interface`);
    assert.equal(toFunctionSelector(method), toFunctionSelector(frozen));
    assert.deepEqual(method.inputs, frozen.inputs, `${method.name}: input tuple`);
    assert.deepEqual(method.outputs, frozen.outputs, `${method.name}: output tuple`);
  }
  const commitEntry = methods.find((method) => method.name === 'commitSquad');
  assert.deepEqual(
    commitEntry.inputs.map((input) => input.type),
    ['uint256', 'bytes32'],
    'Commit calldata contains no lineup or Salt',
  );
  const client = createPublicClient({
    chain: anvil,
    transport: http(deployment.rpcUrl, { retryCount: 0, fetchOptions: { signal: abort.signal } }),
    cacheTime: 0,
  });
  assert.equal(await client.getChainId(), deployment.chainId);
  const version = await client.request({ method: 'web3_clientVersion' });
  assert.ok(
    engine === 'geth' ? /geth\//i.test(version) : /anvil/i.test(version),
    'Actual node engine',
  );
  const accounts = [0, 1].map((addressIndex) =>
    mnemonicToAccount('test test test test test test test test test test test junk', {
      addressIndex,
    }),
  );
  const wallets = accounts.map((account) =>
    createWalletClient({
      account,
      chain: anvil,
      transport: http(deployment.rpcUrl, { retryCount: 0, fetchOptions: { signal: abort.signal } }),
    }),
  );
  result.signing = 'Both development accounts sign locally and broadcast eth_sendRawTransaction.';
  result.originalArena = deployment.arenaAddress;
  result.chainId = deployment.chainId;
  report.stage = `${engine}:signed-room-transactions`;

  async function broadcast(side, operation, data, to) {
    abort.signal.throwIfAborted();
    const request = await wallets[side].prepareTransactionRequest({ data, ...(to ? { to } : {}) });
    const serializedTransaction = await wallets[side].signTransaction(request);
    abort.signal.throwIfAborted();
    const hash = await client.sendRawTransaction({ serializedTransaction });
    assert.equal(hash, keccak256(serializedTransaction), `${operation}: signed hash`);
    const receipt = await client.waitForTransactionReceipt({
      hash,
      timeout: 35_000,
      pollingInterval: 100,
    });
    assert.equal(receipt.status, 'success', `${operation}: receipt`);
    assert.equal(getAddress(receipt.from), accounts[side].address, `${operation}: signer`);
    const transaction = await client.getTransaction({ hash });
    assert.equal(transaction.input, data, `${operation}: actual calldata`);
    assert.equal(getAddress(transaction.from), accounts[side].address);
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    assert.equal(block.hash, receipt.blockHash, `${operation}: canonical receipt source`);
    result.receipts.push({
      operation,
      hash,
      from: receipt.from,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      gasUsed: Number(receipt.gasUsed),
      input: data,
    });
    return { receipt, timestamp: block.timestamp };
  }

  const created = await broadcast(0, 'deploy', artifact.bytecode.object);
  const address = created.receipt.contractAddress;
  assert.ok(address, 'Dedicated Squad deployment address');
  assert.notEqual(
    getAddress(address),
    getAddress(deployment.arenaAddress),
    'Original Arena must remain independent',
  );
  result.address = address;
  const read = (functionName, args = [], blockNumber) =>
    client.readContract({
      address,
      abi,
      functionName,
      args,
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
  const send = (side, functionName, args) =>
    broadcast(side, functionName, encodeFunctionData({ abi, functionName, args }), address);
  assert.equal(await read('getRulesetId'), config.rulesetId);
  assert.deepEqual(await read('getSchemaVersions'), config.ruleDefinition.schemas);
  assert.deepEqual(plain(await read('getRules')), config.ruleDefinition);
  assert.equal(
    (await client.getCode({ address })).toLowerCase(),
    runtimeCode(artifact, config.rulesetId),
    'Actual deployed runtime',
  );
  result.deployment = {
    hash: created.receipt.transactionHash,
    blockNumber: created.receipt.blockNumber.toString(),
    blockHash: created.receipt.blockHash,
    rulesetId: config.rulesetId,
    schemas: config.ruleDefinition.schemas,
    compiler: artifact.metadata.compiler.version,
    settings: artifact.metadata.settings,
  };

  function events(receipt, expected) {
    assert.equal(receipt.logs.length, expected.length, 'Only required public events are emitted');
    return receipt.logs.map((log, index) => {
      assert.equal(getAddress(log.address), getAddress(address));
      const event = decodeEventLog({ abi, topics: log.topics, data: log.data, strict: true });
      assert.equal(event.eventName, expected[index]);
      assert.equal(
        log.topics[0],
        config.events.find((definition) => definition.name === event.eventName).topic,
      );
      return event.args;
    });
  }

  async function checkState(id, mapId, phase, expectedCommitments, deadline, blockNumber) {
    const [summary, battle, squad, turn] = await Promise.all([
      read('getMatch', [id], blockNumber),
      read('getBattleState', [id], blockNumber),
      read('getSquadStatus', [id], blockNumber),
      read('getRoundStatus', [id], blockNumber),
    ]);
    assert.equal(summary.mapId, mapId);
    assert.equal(summary.mapHash, config.ruleDefinition.mapHashes[mapId - 1]);
    assert.equal(summary.rulesetId, config.rulesetId);
    assert.equal(summary.phase, phase);
    assert.equal(summary.activeRound, expectedCommitments.battle.battleStarted ? 1 : 0);
    assert.equal(summary.phaseDeadline, deadline);
    assert.equal(summary.joinDeadline, expectedCommitments.joinDeadline);
    assert.equal(summary.stateHash, expectedCommitments.stateHash);
    assert.equal(summary.outcome, 0);
    assert.equal(summary.reason, 0);
    assert.equal(getAddress(summary.players[0]), accounts[0].address);
    if (phase !== config.phases.WAITING || expectedCommitments.joined)
      assert.equal(getAddress(summary.players[1]), accounts[1].address);
    else assert.equal(BigInt(summary.players[1]), 0n);
    assert.deepEqual(battle, expectedCommitments.battle);
    assert.deepEqual(squad.commitments, expectedCommitments.values);
    assert.deepEqual(squad.committed, expectedCommitments.flags);
    assert.deepEqual(squad.revealed, expectedCommitments.revealed);
    assert.deepEqual(squad.unitTypes, expectedCommitments.unitTypes);
    assert.deepEqual(turn, {
      commitments: [zeroHash, zeroHash],
      committed: [false, false],
      revealed: [false, false],
    });
    return summary;
  }

  for (const mapId of [1, 2, 3]) {
    report.stage = `${engine}:map-${mapId}`;
    const map = await read('getMap', [mapId]);
    assert.equal(map.mapHash, config.ruleDefinition.mapHashes[mapId - 1]);
    const creation = await send(0, 'createMatch', [mapId]);
    const [roomEvent, waitingEvent] = events(creation.receipt, ['MatchCreated', 'PhaseAdvanced']);
    const id = roomEvent.matchId;
    assert.equal(id, BigInt(mapId));
    const joinDeadline = creation.timestamp + BigInt(config.ruleDefinition.windows[0]);
    assert.deepEqual(roomEvent, {
      matchId: id,
      creator: accounts[0].address,
      rulesetId: config.rulesetId,
      mapId,
      mapHash: map.mapHash,
      joinDeadline,
    });
    assert.deepEqual(waitingEvent, {
      matchId: id,
      round: 0,
      fromPhase: 0,
      toPhase: config.phases.WAITING,
      deadline: joinDeadline,
    });
    const expected = {
      values: [zeroHash, zeroHash],
      flags: [false, false],
      joined: false,
      revealed: [false, false],
      unitTypes: [
        [0, 0, 0],
        [0, 0, 0],
      ],
      stateHash: zeroHash,
      joinDeadline,
      battle: {
        mapId,
        battleStarted: false,
        completedRound: 0,
        units: Array.from({ length: 6 }, () => ({
          unitType: 0,
          position: 255,
          hp: 0,
          alive: false,
          lockedRound: 0,
        })),
        energy: [0, 0],
        victoryPoints: [0, 0],
        outcome: 0,
        reason: 0,
      },
    };
    await checkState(id, mapId, config.phases.WAITING, expected, 0n, creation.receipt.blockNumber);
    const joining = await send(1, 'joinMatch', [id]);
    const [joinEvent] = events(joining.receipt, ['PlayerJoined']);
    assert.deepEqual(joinEvent, {
      matchId: id,
      player: accounts[1].address,
      phase: config.phases.WAITING,
      joinDeadline,
    });
    expected.joined = true;
    const waiting = await checkState(
      id,
      mapId,
      config.phases.WAITING,
      expected,
      0n,
      joining.receipt.blockNumber,
    );
    assert.equal(waiting.joinDeadline, joinDeadline);
    const starting = await send(0, 'startMatch', [id]);
    const commitDeadline = starting.timestamp + BigInt(config.ruleDefinition.windows[1]);
    const [startEvent] = events(starting.receipt, ['PhaseAdvanced']);
    assert.deepEqual(startEvent, {
      matchId: id,
      round: 0,
      fromPhase: config.phases.WAITING,
      toPhase: config.phases.SQUAD_COMMIT,
      deadline: commitDeadline,
    });
    await checkState(
      id,
      mapId,
      config.phases.SQUAD_COMMIT,
      expected,
      commitDeadline,
      starting.receipt.blockNumber,
    );
    // Fixture preimages stay local until their own successful public Reveal.
    const preimages = accounts.map((_, side) => ({
      unitTypes: side === 0 ? [1, 4, 5] : [3, 2, 4],
      salt: `0x${randomBytes(32).toString('hex')}`,
    }));
    const commitments = accounts.map((account, side) =>
      keccak256(
        codec.encodeSquad({
          context: { chainId: BigInt(deployment.chainId), arena: address, matchId: id },
          player: account.address,
          rulesetId: config.rulesetId,
          ...preimages[side],
        }),
      ),
    );
    const order = mapId === 2 ? [1, 0] : [0, 1];
    let revealDeadline;
    for (const [index, side] of order.entries()) {
      const sent = await send(side, 'commitSquad', [id, commitments[side]]);
      const nextDeadline =
        index === 1 ? sent.timestamp + BigInt(config.ruleDefinition.windows[2]) : commitDeadline;
      const phase = index === 1 ? config.phases.SQUAD_REVEAL : config.phases.SQUAD_COMMIT;
      const emitted = events(
        sent.receipt,
        index === 1 ? ['SquadCommitted', 'PhaseAdvanced'] : ['SquadCommitted'],
      );
      assert.deepEqual(emitted[0], {
        matchId: id,
        player: accounts[side].address,
        commitment: commitments[side],
      });
      assert.equal(
        sent.receipt.logs[0].data.length,
        66,
        'Commit event data contains exactly one Hash',
      );
      assert.equal(
        result.receipts.at(-1).input.length,
        138,
        'Commit calldata contains only match ID and Hash',
      );
      if (index === 1)
        assert.deepEqual(emitted[1], {
          matchId: id,
          round: 0,
          fromPhase: config.phases.SQUAD_COMMIT,
          toPhase: config.phases.SQUAD_REVEAL,
          deadline: nextDeadline,
        });
      if (index === 1) revealDeadline = nextDeadline;
      expected.values[side] = commitments[side];
      expected.flags[side] = true;
      await checkState(id, mapId, phase, expected, nextDeadline, sent.receipt.blockNumber);
      result.gas.push({
        operation: 'commit',
        mapId,
        position: index === 0 ? 'first' : 'second',
        side,
        hash: sent.receipt.transactionHash,
        gasUsed: Number(sent.receipt.gasUsed),
        target: 100_000,
      });
    }
    const revealOrder = mapId === 3 ? [1, 0] : [0, 1];
    const publicLineups = [];
    const revealSources = [];
    let firstRoundDeadline;
    for (const [index, side] of revealOrder.entries()) {
      report.stage = `${engine}:map-${mapId}:reveal-${index + 1}`;
      const sent = await send(side, 'revealSquad', [
        id,
        preimages[side].unitTypes,
        preimages[side].salt,
      ]);
      const emitted = events(
        sent.receipt,
        index === 0 ? ['SquadRevealed'] : ['SquadRevealed', 'GameStarted', 'PhaseAdvanced'],
      );
      assert.deepEqual(emitted[0], {
        matchId: id,
        player: accounts[side].address,
        ...preimages[side],
      });
      publicLineups[side] = emitted[0].unitTypes;
      expected.revealed[side] = true;
      expected.unitTypes[side] = emitted[0].unitTypes;
      revealSources.push({
        hash: sent.receipt.transactionHash,
        blockNumber: sent.receipt.blockNumber.toString(),
        blockHash: sent.receipt.blockHash,
        player: emitted[0].player,
        unitTypes: emitted[0].unitTypes,
        salt: emitted[0].salt,
      });
      if (index === 0) {
        await checkState(
          id,
          mapId,
          config.phases.SQUAD_REVEAL,
          expected,
          revealDeadline,
          sent.receipt.blockNumber,
        );
      } else {
        // Reconstruct from creation/Reveal logs and the public catalogue, independently of getters.
        expected.battle = initialState(
          { mapId: roomEvent.mapId, side: 0, squad: publicLineups[0], opponent: publicLineups[1] },
          rules,
          maps,
        );
        const context = {
          chainId: BigInt(deployment.chainId),
          arena: address,
          matchId: roomEvent.matchId,
        };
        const encoding = codec.encodeState({
          context,
          rulesetId: roomEvent.rulesetId,
          state: expected.battle,
        });
        expected.stateHash = keccak256(encoding);
        firstRoundDeadline = sent.timestamp + BigInt(config.ruleDefinition.windows[3]);
        assert.deepEqual(emitted[1], {
          matchId: id,
          initialState: expected.battle,
          stateHash: expected.stateHash,
        });
        assert.deepEqual(emitted[2], {
          matchId: id,
          round: 1,
          fromPhase: config.phases.SQUAD_REVEAL,
          toPhase: config.phases.ROUND_COMMIT,
          deadline: firstRoundDeadline,
        });
        await checkState(
          id,
          mapId,
          config.phases.ROUND_COMMIT,
          expected,
          firstRoundDeadline,
          sent.receipt.blockNumber,
        );
        const name = `initial-${engine}-map-${mapId}-match-${id}`;
        hashCases.push({
          name,
          kind: 4,
          input: plain({ context, rulesetId: roomEvent.rulesetId, state: expected.battle }),
          expectedEncoding: encoding,
          expectedHash: expected.stateHash,
        });
        result.initializations.push(
          plain({
            name,
            context,
            rulesetId: roomEvent.rulesetId,
            state: expected.battle,
            encoding,
            stateHash: expected.stateHash,
            creation: {
              hash: creation.receipt.transactionHash,
              blockNumber: creation.receipt.blockNumber,
              blockHash: creation.receipt.blockHash,
            },
            reveals: revealSources,
            gameStarted: {
              hash: sent.receipt.transactionHash,
              blockNumber: sent.receipt.blockNumber,
              blockHash: sent.receipt.blockHash,
            },
          }),
        );
      }
      result.gas.push({
        operation: 'reveal',
        mapId,
        position: index === 0 ? 'first' : 'second',
        side,
        hash: sent.receipt.transactionHash,
        gasUsed: Number(sent.receipt.gasUsed),
        target: 250_000,
      });
    }
    result.maps.push({
      mapId,
      matchId: id.toString(),
      order,
      phase: config.phases.ROUND_COMMIT,
      commitments,
      revealOrder,
      stateHash: expected.stateHash,
      firstRoundDeadline: firstRoundDeadline.toString(),
    });
    console.log(
      `PASS: ${engine} Squad map ${mapId}: manual host start, both signed Commit/Reveal, one-sided privacy, event-derived six-unit initialization and first-round state Hash.`,
    );
  }
  await checkSignedTurns({
    path,
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
  });
  report.stage = `${engine}:public-protocol-encoding`;
  const stateFile = resolve(simulation, `initial-states-${engine}.json`);
  await saveJson(stateFile, { cases: hashCases });
  const independent = await run(path('.local/bin/arena-server'), ['check-protocol', stateFile], {
    cwd: path('server'),
    signal: abort.signal,
    maxBuffer: 4 * 1024 * 1024,
  });
  const goStates = JSON.parse(independent.stdout).vectors;
  assert.equal(
    goStates.length,
    hashCases.length,
    'All initial, action and resolved-state encodings',
  );
  assert.equal(
    hashCases.filter((entry) => entry.kind === 3).length,
    40,
    'Both public action bundles per round',
  );
  assert.equal(
    hashCases.filter((entry) => entry.kind === 4).length,
    23,
    'Three initial states and twenty resolved states',
  );
  for (const [index, actual] of goStates.entries()) {
    const expected = hashCases[index];
    assert.equal(actual.name, expected.name);
    assert.equal(actual.accepted, true, `${expected.name}: Go accepted`);
    assert.equal(
      actual.encoding,
      expected.expectedEncoding,
      `${expected.name}: Go/TypeScript bytes`,
    );
    assert.equal(actual.hash, expected.expectedHash, `${expected.name}: Go/TypeScript/chain Hash`);
  }
  result.encoding = {
    status: 'passed',
    states: hashCases.filter((entry) => entry.kind === 4).length,
    actionBundles: hashCases.filter((entry) => entry.kind === 3).length,
    languages: ['Solidity', 'Go', 'TypeScript'],
    source:
      'Confirmed creation, Squad/Action Reveal and RoundResolved events plus the frozen public catalogue. Go checks encoding and Hash, not independent battle resolution.',
  };
  result.budgetMisses = result.gas.filter((sample) => sample.gasUsed >= sample.target);
  for (const sample of result.budgetMisses)
    console.error(
      `Gas target missed: ${engine} map ${sample.mapId} ${sample.position} ${sample.scope ?? 'squad'} ${sample.operation}: ${sample.gasUsed}, target<${sample.target}`,
    );
  assert.equal(result.budgetMisses.length, 0, 'Squad and battle transaction Gas target misses');
  assert.equal(
    await readFile(publishedFile, 'utf8'),
    published,
    'Original published deployment retained',
  );
  result.status = 'passed';
  result.completedAt = new Date().toISOString();
  for (const scope of ['squad', 'battle'])
    for (const operation of ['commit', 'reveal']) {
      const first = result.gas.filter(
        (sample) =>
          (sample.scope ?? 'squad') === scope &&
          sample.operation === operation &&
          sample.position === 'first',
      );
      const second = result.gas.filter(
        (sample) =>
          (sample.scope ?? 'squad') === scope &&
          sample.operation === operation &&
          sample.position === 'second',
      );
      console.log(
        `PASS: ${engine} ${scope} ${operation} receipt Gas: first maximum=${Math.max(...first.map((sample) => sample.gasUsed))}, second maximum=${Math.max(...second.map((sample) => sample.gasUsed))}; both targets<${first[0].target}.`,
      );
    }
  const settlements = result.gas.filter((sample) => sample.operation === 'settle');
  assert.equal(settlements.length, 20, 'Every complete battle round has a settlement receipt');
  console.log(
    `PASS: ${engine} battle settlement receipt Gas: maximum=${Math.max(...settlements.map((sample) => sample.gasUsed))}; target<1500000.`,
  );
  if (engine === 'geth') {
    assert.deepEqual(Object.keys(report.engines).sort(), ['anvil', 'geth']);
    assert.ok(Object.values(report.engines).every((entry) => entry.status === 'passed'));
    report.status = 'passed';
    delete report.stage;
    console.log(
      'PASS: room and battle protocol, 360 frozen initializations, both local engines, forty signed battle rounds, actual skill/Cover effects and three-language public action/state Hash agreement.',
    );
  }
} catch (error) {
  report.status = 'failed';
  result.status = 'failed';
  // Viem's concise reason omits request calldata that may contain an unbroadcast Reveal.
  const message = error.shortMessage ?? error.message;
  result.error = message.split('\n')[0];
  report.error = plain({
    stage: report.stage,
    message,
    expected: error.expected,
    actual: error.actual,
  });
  const failureDir = path('.local/safety/squad-failures');
  await mkdir(failureDir, { recursive: true });
  report.failure = `.local/safety/squad-failures/rooms-${new Date().toISOString().replaceAll(':', '-')}.json`;
  const native = await readJson(path('.local/safety/squad-room-tests.json')).catch(() => ({}));
  const nativeGas = await readJson(path('.local/safety/squad-reveal-gas-tests.json')).catch(
    () => ({}),
  );
  const battleNative = await readJson(path('.local/safety/squad-battle-tests.json')).catch(
    () => ({}),
  );
  const turnGas = await readJson(path('.local/safety/squad-turn-gas-tests.json')).catch(() => ({}));
  await saveJson(path(report.failure), { report, native, nativeGas, battleNative, turnGas });
  console.error(`FAIL: Squad rooms (${report.stage}): ${result.error}`);
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.exitCode = 1;
} finally {
  report.updatedAt = new Date().toISOString();
  await saveJson(file, report);
}
