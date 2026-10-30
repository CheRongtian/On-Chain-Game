import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { preview } from 'vite';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseEventLogs,
  toFunctionSelector,
} from 'viem';
import { anvil } from 'viem/chains';
import { installedBrowser } from './browser.mjs';
import { verifyDeployment } from '../../scripts/deployment.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
assert.equal(
  process.env.ARENA_TEST_PROJECT_ROOT,
  root.replace(/\/$/, ''),
  'Persistence acceptance requires the isolated test workspace.',
);
const browserPort = Number(process.env.ARENA_BROWSER_PORT);
const base = `http://127.0.0.1:${browserPort}`;
const backend = `http://${process.env.HTTP_ADDRESS}`;
const json = async (file) => JSON.parse(await readFile(resolve(root, file), 'utf8'));
const deployment = await json('client/public/deployment.json');
const acceptance = await json('.local/indexer/acceptance.json');
const { abi } = await json('contracts/out/Arena.sol/Arena.json');
const chain = createPublicClient({
  chain: anvil,
  transport: http(deployment.rpcUrl),
  cacheTime: 0,
});
const wallet = createWalletClient({ chain: anvil, transport: http(deployment.rpcUrl) });
const report = { status: 'running', checks: [] };
let browser, server, keeper, keeperExit;
let interrupted = false;

function passed(message) {
  report.checks.push(message);
  console.log(`PASS: persistence ${message}.`);
}
async function waitFor(check, message) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (interrupted) throw new Error('Persistence acceptance interrupted.');
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(message);
}
async function api(path) {
  const response = await fetch(backend + path, { signal: AbortSignal.timeout(35_000) });
  assert.equal(response.status, 200, `Read API ${path}`);
  return response.json();
}
async function send(account, functionName, args) {
  const hash = await wallet.writeContract({
    account,
    address: deployment.arenaAddress,
    abi,
    functionName,
    args,
  });
  const receipt = await chain.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', functionName);
  return receipt;
}
async function confirm(page) {
  const button = page.getByRole('button', { name: 'Confirm orders', exact: true });
  await waitFor(() => button.isEnabled(), 'Order confirmation did not become available.');
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Confirm orders?', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function savedOrders(page) {
  return page.evaluate(
    () =>
      new Promise((done, fail) => {
        const request = indexedDB.open('arena-orders', 1);
        request.onerror = () => fail(new Error('Order storage could not be opened.'));
        request.onsuccess = () => {
          const db = request.result;
          const read = db.transaction('secrets').objectStore('secrets').getAll();
          read.onsuccess = () => {
            db.close();
            done(read.result);
          };
          read.onerror = () => {
            db.close();
            fail(new Error('Saved orders could not be read.'));
          };
        };
      }),
  );
}
async function request(operation) {
  await writeFile(resolve(root, '.local/indexer-command'), operation + '\n');
  process.kill(Number(await readFile(resolve(root, '.local/backend.pid'), 'utf8')), 'SIGUSR1');
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = true;
    keeper?.stdin.end();
    void browser?.close();
  });

try {
  keeper = spawn(resolve(root, '.local/bin/arena-server'), ['browser-fault', 'hold-keeper'], {
    cwd: resolve(root, 'server'),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  keeperExit = new Promise((done) => keeper.once('close', done));
  await new Promise((done, fail) => {
    keeper.once('error', fail);
    keeper.once('exit', () =>
      fail(new Error('Keeper could not be paused for persistence acceptance.')),
    );
    keeper.stdout.once('data', done);
  });
  const accounts = (await wallet.getAddresses()).map((address) => getAddress(address));
  const creation = await send(accounts[0], 'createMatch', [1]);
  const id = parseEventLogs({ abi, logs: creation.logs, eventName: 'MatchCreated' })[0].args
    .matchId;
  await send(accounts[1], 'joinMatch', [id]);
  await send(accounts[0], 'startMatch', [id]);
  server = await preview({
    root: resolve(root, 'client'),
    preview: { host: '127.0.0.1', port: browserPort, strictPort: true },
  });
  browser = await chromium.launch({ executablePath: await installedBrowser(), headless: true });
  const pages = [];
  for (const account of accounts.slice(0, 2)) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(35_000);
    await page.goto(base);
    const selector = page.getByLabel('Active account', { exact: true });
    await waitFor(() => selector.isEnabled(), 'Local wallet did not connect.');
    await selector.selectOption(account);
    await page.goto(`${base}/rooms/${id}/battle`);
    pages.push(page);
  }
  await confirm(pages[0]);
  await waitFor(async () => {
    const status = await chain.readContract({
      address: deployment.arenaAddress,
      abi,
      functionName: 'getRoundStatus',
      args: [id],
    });
    return status.committed[0];
  }, 'Host commitment did not reach the chain.');
  const before = await savedOrders(pages[0]);
  assert.equal(before.length, 1, 'One pending secret must be stored before restarting.');
  await waitFor(async () => {
    const state = (await api('/sync')).sync;
    return state.ready && BigInt(state.indexedBlock) === (await chain.getBlockNumber());
  }, 'Indexing did not reach the committed round before its persistence baseline.');
  const nodePID = await readFile(resolve(root, '.local/anvil.pid'), 'utf8');
  const sync = (await api('/sync')).sync;
  const oldHash = acceptance.matches[0].source.transactionHash;
  const oldReceipt = await chain.getTransactionReceipt({ hash: oldHash });
  const oldLogs = await chain.getLogs({
    address: deployment.arenaAddress,
    fromBlock: BigInt(deployment.deploymentBlock),
    toBlock: oldReceipt.blockNumber,
  });
  const oldTransaction = await api(`/transactions/${oldHash}`);
  const baseline = await chain.readContract({
    address: deployment.arenaAddress,
    abi,
    functionName: 'getBattleState',
    args: [BigInt(acceptance.matches[0].id)],
    blockNumber: oldReceipt.blockNumber,
  });
  await request('reload-chain');
  await waitFor(async () => {
    if (
      (await readFile(resolve(root, '.local/anvil.pid'), 'utf8').catch(() => nodePID)) === nodePID
    )
      return false;
    const response = await fetch(backend + '/sync').catch(() => undefined);
    if (!response?.ok) return false;
    const state = (await response.json()).sync;
    return state.ready && state.processId !== sync.processId;
  }, 'The saved chain and Go service did not recover.');
  const restored = await json('client/public/deployment.json');
  for (const field of [
    'arenaAddress',
    'deploymentBlock',
    'deploymentHash',
    'transactionHash',
    'deployedAt',
  ])
    assert.equal(
      restored[field],
      deployment[field],
      `Deployment ${field} changed after node restart.`,
    );
  assert.equal(
    (await chain.getTransactionReceipt({ hash: oldHash })).blockHash,
    oldReceipt.blockHash,
  );
  assert.deepEqual(
    await chain.getLogs({
      address: deployment.arenaAddress,
      fromBlock: BigInt(deployment.deploymentBlock),
      toBlock: oldReceipt.blockNumber,
    }),
    oldLogs,
  );
  assert.deepEqual(
    await chain.readContract({
      address: deployment.arenaAddress,
      abi,
      functionName: 'getBattleState',
      args: [BigInt(acceptance.matches[0].id)],
      blockNumber: oldReceipt.blockNumber,
    }),
    baseline,
  );
  assert.deepEqual((await api(`/transactions/${oldHash}`)).transaction, oldTransaction.transaction);
  passed(
    'node restart reuses the deployment, old receipts, events, fees, and retained historical state',
  );
  await pages[0].reload();
  await pages[0].getByText('Waiting for your opponent', { exact: true }).waitFor();
  assert.ok(
    JSON.stringify(await savedOrders(pages[0])) === JSON.stringify(before),
    'The saved orders or salt changed across node restart.',
  );
  await confirm(pages[1]);
  await waitFor(
    async () =>
      (
        await chain.readContract({
          address: deployment.arenaAddress,
          abi,
          functionName: 'getMatch',
          args: [id],
        })
      ).round === 2,
    'Recovered orders did not reveal and settle.',
  );
  const reveals = await chain.getContractEvents({
    address: deployment.arenaAddress,
    abi,
    eventName: 'ActionRevealed',
    args: { matchId: id, round: 1 },
    fromBlock: creation.blockNumber,
  });
  assert.ok(
    reveals.some(
      (event) =>
        event.args.player.toLowerCase() === accounts[0].toLowerCase() &&
        event.args.salt === before[0].salt,
    ),
    'Reveal did not use the original saved secret.',
  );
  passed(
    'browser refresh recovers the original IndexedDB secret and reveals it after node restart',
  );
  let unavailableReads = 0;
  const battleSelector = toFunctionSelector('getBattleState(uint256)');
  await pages[0].context().route(deployment.rpcUrl, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    if (
      body.method === 'eth_call' &&
      body.params[0].data?.startsWith(battleSelector) &&
      /^0x[\da-f]+$/i.test(body.params[1])
    ) {
      const events = await chain.getContractEvents({
        address: deployment.arenaAddress,
        abi,
        eventName: 'RoundResolved',
        args: { matchId: id, round: 2 },
        fromBlock: creation.blockNumber,
      });
      if (events[0] && BigInt(body.params[1]) === events[0].blockNumber - 1n) {
        unavailableReads++;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32000, message: 'Required data unavailable' },
          }),
        });
      }
    }
    return route.continue();
  });
  await confirm(pages[0]);
  await confirm(pages[1]);
  await waitFor(
    async () =>
      (
        await chain.readContract({
          address: deployment.arenaAddress,
          abi,
          functionName: 'getMatch',
          args: [id],
        })
      ).round === 3,
    'The historical-state fallback blocked settlement.',
  );
  await waitFor(
    () => pages[0].getByRole('button', { name: 'Confirm orders', exact: true }).isEnabled(),
    'Latest confirmed gameplay did not recover after historical state expired.',
  );
  assert.ok(unavailableReads > 0, 'The old-state read was not exercised.');
  passed(
    'expired animation state falls back to the latest confirmed board without blocking the next round',
  );
  for (const player of pages) await player.context().close();
  const page = await browser.newPage();
  await page.goto(`${base}/transactions/${oldHash}`);
  await page
    .getByRole('heading', { name: 'Transaction receipt · Succeeded', exact: true })
    .waitFor();
  passed('the transaction page displays the canonical saved receipt');
  const prior = (await api('/sync')).sync;
  await request('reindex');
  await waitFor(async () => {
    const response = await fetch(backend + '/sync').catch(() => undefined);
    if (!response?.ok) return false;
    const state = (await response.json()).sync;
    return state.ready && state.processId !== prior.processId;
  }, 'Index rebuilding did not finish after restoring the chain.');
  const verification = await api(`/matches/${acceptance.matches[0].id}/verification`);
  assert.equal(verification.verification.status, 'Verified');
  passed('reindex rebuilds old history from the restored chain and independently verifies replay');
  const manifest = await json('.local/chain/deployment.json');
  await assert.rejects(
    verifyDeployment(root, deployment.rpcUrl, {
      ...manifest,
      deployment: { ...manifest.deployment, rulesHash: '0x' + '00'.repeat(32) },
    }),
    /invalid or has different rules/,
  );
  await assert.rejects(
    verifyDeployment(root, deployment.rpcUrl, {
      ...manifest,
      artifact: { ...manifest.artifact, bytecode: { object: '0x00' } },
    }),
    /differs from the saved deployment baseline/,
  );
  passed('different rules and compiler artifacts are rejected without changing saved data');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
  console.error(`FAIL: persistence ${error.message}`);
} finally {
  await browser?.close();
  await server?.close();
  if (keeper) {
    keeper.stdin.end();
    await keeperExit;
  }
  await mkdir(resolve(root, '.local/browser'), { recursive: true });
  await writeFile(
    resolve(root, '.local/browser/persistence.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
}
