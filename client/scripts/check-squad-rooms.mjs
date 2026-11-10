import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

const root = fileURLToPath(new URL('../../', import.meta.url));
const path = (name) => resolve(root, name);
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
const result = { status: 'running', engine, receipts: [], maps: [], gas: [], budgetMisses: [] };

try {
  if (engine === 'geth')
    assert.equal(report.engines.anvil.status, 'passed', 'Anvil room acceptance must precede Geth');
  report.status = 'running';
  report.stage = `${engine}:preparation`;
  report.engines[engine] = result;
  await saveJson(file, report);
  if (engine === 'anvil') {
    await mkdir(path('.local/safety'), { recursive: true });
    const nativeFile = path('.local/safety/squad-room-tests.json');
    await writeFile(nativeFile, '{}\n');
    report.stage = 'native-room-protocol';
    console.log(
      'Checking room permissions, manual host start, immutable opaque commits, deadlines, event privacy and context isolation...',
    );
    const native = await run(
      'forge',
      [
        'test',
        '--match-contract',
        '^SquadRoomTest$',
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
    assert.equal(suites.length, 1, 'Dedicated room suite');
    const [suite, outcome] = suites[0];
    assert.deepEqual(outcome.warnings, [], 'Room test warnings');
    const tests = Object.entries(outcome.test_results).map(([name, test]) => {
      assert.equal(test.status, 'Success', `${name}: ${test.reason ?? 'native test failed'}`);
      return { name, kind: test.kind };
    });
    assert.equal(tests.length, 10, 'Complete room protocol cases');
    const fuzz = tests.filter((test) => test.kind.Fuzz);
    assert.equal(fuzz.length, 1, 'Commit order/deadline fuzz target');
    assert.equal(fuzz[0].kind.Fuzz.runs, 64);
    report.native = { status: 'passed', suite, tests, fuzzRuns: 64 };
  }
  assert.equal(report.native.status, 'passed');
  const config = await readJson(path('config/squad-protocol.json'));
  const artifact = await readJson(path('contracts/out/SquadArena.sol/SquadArena.json'));
  const frozenInterface = await readJson(path('contracts/out/ISquadArena.sol/ISquadArena.json'));
  const { abi } = artifact;
  const methods = abi.filter((entry) => entry.type === 'function');
  assert.equal(methods.length, 12, 'Implemented room and metadata entries');
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
    assert.equal(summary.activeRound, 0);
    assert.equal(summary.phaseDeadline, deadline);
    assert.equal(summary.stateHash, zeroHash);
    assert.equal(summary.outcome, 0);
    assert.equal(summary.reason, 0);
    assert.equal(getAddress(summary.players[0]), accounts[0].address);
    if (phase !== config.phases.WAITING || expectedCommitments.joined)
      assert.equal(getAddress(summary.players[1]), accounts[1].address);
    else assert.equal(BigInt(summary.players[1]), 0n);
    assert.deepEqual(battle, {
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
    });
    assert.deepEqual(squad.commitments, expectedCommitments.values);
    assert.deepEqual(squad.committed, expectedCommitments.flags);
    assert.deepEqual(squad.revealed, [false, false]);
    assert.deepEqual(squad.unitTypes, [
      [0, 0, 0],
      [0, 0, 0],
    ]);
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
    const expected = { values: [zeroHash, zeroHash], flags: [false, false], joined: false };
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
    // Fixture preimages stay out of Commit calldata and retained reports.
    const commitments = accounts.map((account, side) =>
      keccak256(
        encodeAbiParameters(parseAbiParameters(config.encodings.squad), [
          config.domains[1].value,
          [BigInt(deployment.chainId), address, id],
          account.address,
          config.rulesetId,
          side === 0 ? [1, 4, 5] : [3, 2, 4],
          `0x${randomBytes(32).toString('hex')}`,
        ]),
      ),
    );
    const order = mapId === 2 ? [1, 0] : [0, 1];
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
      expected.values[side] = commitments[side];
      expected.flags[side] = true;
      await checkState(id, mapId, phase, expected, nextDeadline, sent.receipt.blockNumber);
      result.gas.push({
        mapId,
        position: index === 0 ? 'first' : 'second',
        side,
        hash: sent.receipt.transactionHash,
        gasUsed: Number(sent.receipt.gasUsed),
        target: 100_000,
      });
    }
    result.maps.push({
      mapId,
      matchId: id.toString(),
      order,
      phase: config.phases.SQUAD_REVEAL,
      commitments,
    });
    console.log(
      `PASS: ${engine} Squad room map ${mapId}: create, join without start, manual host start, both signed commits, canonical empty board, frozen metadata and public event privacy.`,
    );
  }
  result.budgetMisses = result.gas.filter((sample) => sample.gasUsed >= sample.target);
  for (const sample of result.budgetMisses)
    console.error(
      `Gas target missed: ${engine} map ${sample.mapId} ${sample.position} Squad Commit: ${sample.gasUsed}, target<${sample.target}`,
    );
  assert.equal(result.budgetMisses.length, 0, 'Squad Commit Gas target misses');
  assert.equal(
    await readFile(publishedFile, 'utf8'),
    published,
    'Original published deployment retained',
  );
  result.status = 'passed';
  result.completedAt = new Date().toISOString();
  const first = result.gas.filter((sample) => sample.position === 'first');
  const second = result.gas.filter((sample) => sample.position === 'second');
  console.log(
    `PASS: ${engine} Squad Commit receipt Gas: first maximum=${Math.max(...first.map((sample) => sample.gasUsed))}, second maximum=${Math.max(...second.map((sample) => sample.gasUsed))}; both targets<100000.`,
  );
  if (engine === 'geth') {
    assert.deepEqual(Object.keys(report.engines).sort(), ['anvil', 'geth']);
    assert.ok(Object.values(report.engines).every((entry) => entry.status === 'passed'));
    report.status = 'passed';
    delete report.stage;
    console.log(
      'PASS: native room protocol, both local node engines, six real map-specific rooms and twelve signed Squad Commit receipts.',
    );
  }
} catch (error) {
  report.status = 'failed';
  result.status = 'failed';
  result.error = error.message.split('\n')[0];
  report.error = plain({
    stage: report.stage,
    message: error.message,
    expected: error.expected,
    actual: error.actual,
  });
  const failureDir = path('.local/safety/squad-failures');
  await mkdir(failureDir, { recursive: true });
  report.failure = `.local/safety/squad-failures/rooms-${new Date().toISOString().replaceAll(':', '-')}.json`;
  const native = await readJson(path('.local/safety/squad-room-tests.json')).catch(() => ({}));
  await saveJson(path(report.failure), { report, native });
  console.error(`FAIL: Squad rooms (${report.stage}): ${result.error}`);
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.exitCode = 1;
} finally {
  report.updatedAt = new Date().toISOString();
  await saveJson(file, report);
}
