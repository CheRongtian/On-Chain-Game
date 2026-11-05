import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { encodeFunctionData } from 'viem';
import { readJson, saveJson, rpc } from '../../scripts/deployment.mjs';
import { backupDatabase, restoreDatabase, databaseSQL } from '../../scripts/database-backup.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const workspace = process.env.ARENA_TEST_PROJECT_ROOT;
assert.equal(
  workspace ? resolve(workspace) : undefined,
  root,
  'Operational faults require the isolated test workspace.',
);
const source = await readJson(resolve(root, 'client/public/deployment.json'));
const acceptance = await readJson(resolve(root, '.local/indexer/acceptance.json'));
const reportPath = resolve(root, `.local/operations/${source.engine}.json`);
const base = `http://${process.env.HTTP_ADDRESS || '127.0.0.1:18081'}`;
const run = promisify(execFile);
const phase = process.argv[2];
const report =
  phase === 'prepare'
    ? { status: 'running', engine: source.engine, checks: [], startedAt: new Date().toISOString() }
    : await readJson(reportPath);

async function native(...args) {
  return run(resolve(root, '.local/bin/arena-server'), args, {
    cwd: resolve(root, 'server'),
    timeout: 40_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}
async function api(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(35_000) });
  assert.equal(response.status, 200, `Operational API ${path}`);
  return response.json();
}
async function waitFor(check, message) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(message);
}
async function records() {
  return JSON.parse((await native('browser-fault', 'database-state')).stdout).records;
}
async function metrics() {
  const response = await fetch(base + '/metrics', { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  const text = await response.text();
  const values = Object.fromEntries(
    text
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const split = line.lastIndexOf(' ');
        return [line.slice(0, split), Number(line.slice(split + 1))];
      }),
  );
  assert.ok(Object.values(values).every(Number.isFinite), 'Metrics must contain finite values.');
  return values;
}
async function verified() {
  for (const match of acceptance.matches) {
    const result = await api(`/matches/${match.id}/verification`);
    assert.equal(result.verification.status, 'Verified');
    assert.equal(result.verification.canonical, true);
  }
}
function passed(message) {
  report.checks.push(message);
  console.log(`PASS: operations ${message}.`);
}

try {
  await mkdir(resolve(root, '.local/operations'), { recursive: true });
  if (phase === 'prepare') {
    assert.equal(acceptance.status, 'passed');
    console.log((await native('check-operations')).stdout.trim());
    passed('shared limits, pagination, stream capacity and diagnostic redaction self-checks');
    await waitFor(
      async () => (await metrics()).arena_rpc_probes_total > 0,
      'Background RPC probes were not measured.',
    );
    const before = await metrics();
    report.metricsBefore = before;
    for (const name of ['arena_rpc_up', 'arena_database_up', 'arena_indexer_ready'])
      assert.equal(before[name], 1);
    assert.equal(before.arena_indexer_lag_blocks, 0);
    assert.ok(before.arena_last_sync_timestamp_seconds > 0);
    await verified();
    assert.ok((await metrics()).arena_replay_verified_total > before.arena_replay_verified_total);
    await native('browser-fault', 'corrupt');
    try {
      const mismatch = await api(`/matches/${acceptance.matches[0].id}/verification`);
      assert.equal(mismatch.verification.status, 'Mismatch');
      const changed = await metrics();
      assert.ok(changed.arena_replay_mismatch_total > before.arena_replay_mismatch_total);
      assert.equal(changed['arena_alert_active{name="replay_mismatch"}'], 1);
    } finally {
      await native('browser-fault', 'restore');
    }
    await verified();
    assert.equal((await metrics())['arena_alert_active{name="replay_mismatch"}'], 0);
    for (const path of [
      '/matches?limit=0',
      '/matches?limit=101',
      '/matches?offset=-1',
      `/matches/${acceptance.matches[0].id}/replay?limit=101`,
    ]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 400);
      await response.text();
    }
    passed('live metrics, mismatch alarm and recovery, readiness and real API pagination');
    report.before = await records();
    report.backup = await backupDatabase('acceptance-');
    report.keeperBefore = JSON.parse(
      await databaseSQL(
        `SELECT COALESCE(json_agg(json_build_object('id',id,'hash',tx_hash) ORDER BY id),'[]'::json) FROM keeper_attempts`,
      ),
    );
    report.processBefore = (await api('/ready')).processId;
    passed('real PostgreSQL custom-format backup with matching deployment metadata');
  } else if (phase === 'restore') {
    const unavailable = await fetch(base + '/ready', { signal: AbortSignal.timeout(2_000) }).catch(
      () => undefined,
    );
    assert.notEqual(unavailable?.status, 200, 'The stopped API must not report readiness.');
    await unavailable?.body?.cancel();
    const wrongBackup = resolve(root, '.local/operations/foreign-backup');
    const metadata = await readJson(resolve(report.backup, 'backup.json'));
    metadata.published = metadata.published.map((entry) => ({
      ...entry,
      chainId: entry.chainId + 1,
    }));
    await saveJson(resolve(wrongBackup, 'backup.json'), metadata);
    const originalRecords = await records();
    await assert.rejects(restoreDatabase(wrongBackup), /different chain or deployment/);
    assert.deepEqual(
      await records(),
      originalRecords,
      'A foreign backup must be rejected before changing any records.',
    );
    passed('foreign deployment backups are rejected before database replacement');
    const accounts = await rpc(source.rpcUrl, 'eth_accounts');
    const { abi } = await readJson(resolve(root, 'contracts/out/Arena.sol/Arena.json'));
    const hash = await rpc(source.rpcUrl, 'eth_sendTransaction', [
      {
        from: accounts[0],
        to: source.arenaAddress,
        data: encodeFunctionData({ abi, functionName: 'createMatch', args: [1] }),
        gas: '0x4c4b40',
      },
    ]);
    let receipt;
    await waitFor(async () => {
      receipt = await rpc(source.rpcUrl, 'eth_getTransactionReceipt', [hash]);
      return !!receipt;
    }, 'The chain did not accept the transaction while the API was stopped.');
    assert.equal(receipt.status, '0x1');
    report.newTransaction = hash;
    report.catchUpBlock = Number(BigInt(receipt.blockNumber));
    // This database belongs to the disposable test workspace and its API is stopped.
    await databaseSQL('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    report.recoveryBackup = await restoreDatabase(report.backup);
    passed(
      'stopped API cannot confirm history; chain advances independently and the database is actually restored',
    );
  } else if (phase === 'recovered') {
    await waitFor(async () => {
      try {
        const response = await fetch(base + '/ready', { signal: AbortSignal.timeout(35_000) });
        const state = await response.json();
        report.recoveryReady = { httpStatus: response.status, body: state };
        delete report.recoveryError;
        return (
          response.status === 200 &&
          state.ready === true &&
          state.chainId === source.chainId &&
          state.arena.toLowerCase() === source.arenaAddress.toLowerCase() &&
          state.deploymentHash === source.deploymentHash &&
          state.indexedBlock >= report.catchUpBlock
        );
      } catch (error) {
        report.recoveryError = error.message;
        return false;
      }
    }, 'The restored API did not become ready for the expected deployment and catch-up block.');
    const current = await records();
    for (const [name, entries] of Object.entries(report.before)) {
      if (name === 'cursor') continue;
      const actual = new Set(current[name].map((entry) => JSON.stringify(entry)));
      for (const entry of entries)
        assert.ok(
          actual.has(JSON.stringify(entry)),
          `Restored ${name} lost an original public record.`,
        );
    }
    assert.ok(
      current.events.some((event) => event.txHash === report.newTransaction),
      'The transaction after backup must be indexed.',
    );
    const currentHead = await rpc(source.rpcUrl, 'eth_getBlockByNumber', ['latest', false]);
    assert.equal(current.cursor[0].hash, currentHead.hash);
    const attempts = JSON.parse(
      await databaseSQL(
        `SELECT COALESCE(json_agg(json_build_object('id',id,'hash',tx_hash) ORDER BY id),'[]'::json) FROM keeper_attempts`,
      ),
    );
    const retained = new Set(attempts.map((entry) => JSON.stringify(entry)));
    for (const entry of report.keeperBefore)
      assert.ok(
        retained.has(JSON.stringify(entry)),
        'Keeper transaction identities must survive restore.',
      );
    await verified();
    report.restored = current;
    report.restoredProcess = report.recoveryReady.body.processId;
    report.metricsRecovered = await metrics();
    passed(
      'restored records and Keeper transaction identities survive catch-up; original games remain independently Verified',
    );
  } else if (phase === 'reindexed') {
    await waitFor(async () => {
      try {
        return (await api('/ready')).processId !== report.restoredProcess;
      } catch {
        return false;
      }
    }, 'Full reindex did not finish in a replacement Go process.');
    assert.deepEqual(
      await records(),
      report.restored,
      'Full reconstruction and restored incremental history must agree.',
    );
    await verified();
    const comparison = await readJson(resolve(root, '.local/indexer/reindex.json'));
    assert.equal(comparison.matched, true);
    report.status = 'passed';
    report.finishedAt = new Date().toISOString();
    passed(
      'empty projection rebuild from the deployment block matches restored incremental indexing',
    );
  } else throw new Error('Unknown operational acceptance phase.');
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
  console.error(`Operational acceptance failed: ${error.message}`);
} finally {
  await saveJson(reportPath, report);
}
