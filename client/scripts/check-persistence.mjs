import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  parseTransaction,
  toFunctionSelector,
} from 'viem';
import { anvil } from 'viem/chains';
import { installedBrowser, requirePreviewDeployment, waitForReceiptRecovery } from './browser.mjs';
import { compileArchivedSources, rpc, verifyDeployment } from '../../scripts/deployment.mjs';

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
const archive = deployment.engine === 'geth';
const engine = archive ? 'geth' : 'anvil';
const nodeFile = archive ? '.local/geth.pid' : '.local/anvil.pid';
const manifestFile = archive ? '.local/archive/deployment.json' : '.local/chain/deployment.json';
const acceptance = await json('.local/indexer/acceptance.json');
const { abi } = await json('contracts/out/Arena.sol/Arena.json');
const chain = createPublicClient({
  chain: anvil,
  transport: http(deployment.rpcUrl),
  cacheTime: 0,
});
const wallet = createWalletClient({ chain: anvil, transport: http(deployment.rpcUrl) });
const report = { status: 'running', engine, checks: [], requirements: {} };
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

async function historicalAccounts(accounts) {
  const slot = '0x' + '00'.repeat(32);
  const checks = [];
  for (const block of ['0', deployment.deploymentBlock]) {
    const tag = `0x${BigInt(block).toString(16)}`;
    const header = await rpc(deployment.rpcUrl, 'eth_getBlockByNumber', [tag, false]);
    for (const address of [...accounts.slice(0, 2), deployment.arenaAddress]) {
      const value = {
        address: getAddress(address),
        blockNumber: block,
        blockHash: header.hash,
        balanceWei: BigInt(
          await rpc(deployment.rpcUrl, 'eth_getBalance', [address, tag]),
        ).toString(),
        nonce: Number(
          BigInt(await rpc(deployment.rpcUrl, 'eth_getTransactionCount', [address, tag])),
        ),
        code: await rpc(deployment.rpcUrl, 'eth_getCode', [address, tag]),
        slot,
        storage: await rpc(deployment.rpcUrl, 'eth_getStorageAt', [address, slot, tag]),
      };
      assert.deepEqual(
        (await api(`/accounts/${address}?block=${block}&slot=${slot}`)).account,
        value,
      );
      checks.push(value);
    }
  }
  const contract = checks.find(
    (item) =>
      item.address.toLowerCase() === deployment.arenaAddress.toLowerCase() &&
      item.blockNumber === deployment.deploymentBlock,
  );
  assert.ok(contract.code.length > 2, 'The historical deployment must include contract bytecode.');
  assert.equal(
    BigInt(contract.storage),
    1n,
    'The deployment block must retain the original room counter.',
  );
  assert.ok(
    BigInt(
      await rpc(deployment.rpcUrl, 'eth_getStorageAt', [deployment.arenaAddress, slot, 'latest']),
    ) > 1n,
  );
  return checks;
}

async function persistenceFailure(browser) {
  const blocks = resolve(root, '.local/archive/blocks');
  const saved = blocks + '-acceptance';
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(35_000);
  let blocked = false,
    writes = 0,
    submitted,
    acknowledged;
  await context.route(deployment.rpcUrl, async (route) => {
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    if (body?.method !== 'eth_sendRawTransaction') return route.continue();
    writes++;
    acknowledged = await json('.local/archive/confirmed.json');
    await rename(blocks, saved);
    blocked = true;
    await writeFile(blocks, 'Intentional isolated archive write failure.\n');
    const response = await route.fetch();
    submitted = (await response.json()).result;
    await route.fulfill({ response });
  });
  try {
    console.log(
      'Deliberately blocking archive writes in the disposable Geth workspace; confirmation must remain unavailable.',
    );
    await page.goto(base);
    await waitFor(
      () => page.getByLabel('Active account', { exact: true }).isEnabled(),
      'Local accounts did not connect.',
    );
    await page.getByRole('button', { name: 'Create room', exact: true }).click();
    await waitFor(
      () => !!submitted,
      'The persistence fault did not intercept a signed transaction.',
    );
    await assert.rejects(
      rpc(deployment.rpcUrl, 'eth_getTransactionReceipt', [submitted]),
      /persistence failed/i,
    );
    const check = await waitForReceiptRecovery(page);
    assert.equal(
      await page.locator('.transaction-confirmed').count(),
      0,
      'Failed persistence must never display a confirmed transaction.',
    );
    assert.equal(
      new URL(page.url()).pathname,
      '/',
      'An unconfirmed creation must stay in the lobby.',
    );
    assert.deepEqual(
      await json('.local/archive/confirmed.json'),
      acknowledged,
      'A failed archive write must not advance the acknowledged head.',
    );
    await rm(blocks);
    await rename(saved, blocks);
    blocked = false;
    await rpc(deployment.rpcUrl, 'arena_checkpoint');
    await check.click();
    await page.waitForURL(/\/rooms\/\d+$/);
    assert.equal(writes, 1, 'Receipt recovery must reuse the original signed transaction.');
    assert.equal((await chain.getTransactionReceipt({ hash: submitted })).status, 'success');
    await waitFor(async () => {
      const sync = (await api('/sync')).sync;
      return sync.ready && BigInt(sync.indexedBlock) === (await chain.getBlockNumber());
    }, 'Indexing did not recover after restoring archive writes.');
    passed(
      'Geth disk-write failure withholds confirmation in RPC and UI; recovery confirms the original transaction once',
    );
  } finally {
    if (blocked) {
      await rm(blocks, { force: true });
      await rename(saved, blocks);
    }
    await context.close();
  }
}

async function keeperProgression(browser, accounts) {
  const health = await api('/health');
  const address = health.keeper.address;
  assert.ok(health.keeper.enabled && address && !health.keeper.error, 'Geth Keeper must be ready.');
  assert.ok(!accounts.some((player) => player.toLowerCase() === address.toLowerCase()));
  assert.ok(BigInt(await rpc(deployment.rpcUrl, 'eth_getBalance', [address, 'latest'])) > 0n);
  const creation = await send(accounts[0], 'createMatch', [1]);
  const id = parseEventLogs({ abi, logs: creation.logs, eventName: 'MatchCreated' })[0].args
    .matchId;
  await send(accounts[1], 'joinMatch', [id]);
  await send(accounts[0], 'startMatch', [id]);
  const pages = [];
  try {
    for (const account of accounts.slice(0, 2)) {
      const context = await browser.newContext();
      await context.route(deployment.rpcUrl, async (route) => {
        const body =
          route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
        if (
          body?.method === 'eth_sendRawTransaction' &&
          parseTransaction(body.params[0]).data?.startsWith(
            toFunctionSelector('settleRound(uint256,uint8)'),
          )
        )
          return route.abort();
        return route.continue();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(35_000);
      pages.push(page);
      await page.goto(base);
      await waitFor(
        () => page.getByLabel('Active account', { exact: true }).isEnabled(),
        'Geth player accounts did not connect.',
      );
      await page.getByLabel('Active account', { exact: true }).selectOption(account);
      await page.goto(`${base}/rooms/${id}/battle`);
    }
    await confirm(pages[0]);
    await confirm(pages[1]);
    const room = () =>
      chain.readContract({
        address: deployment.arenaAddress,
        abi,
        functionName: 'getMatch',
        args: [id],
      });
    await waitFor(
      async () => (await room()).round === 2,
      'Geth Keeper did not settle the revealed browser orders.',
    );
    const events = await chain.getContractEvents({
      address: deployment.arenaAddress,
      abi,
      eventName: 'RoundResolved',
      args: { matchId: id },
      fromBlock: creation.blockNumber,
    });
    assert.equal(
      (await chain.getTransactionReceipt({ hash: events[0].transactionHash })).from.toLowerCase(),
      address.toLowerCase(),
    );
    for (const page of pages) await page.context().close();
    pages.length = 0;
    const pending = await room();
    await rpc(deployment.rpcUrl, 'arena_advanceClock', [
      `0x${(pending.phaseDeadline + 1n).toString(16)}`,
    ]);
    await waitFor(
      async () => (await room()).phase === 5,
      'Geth Keeper did not finalize the expired phase.',
    );
    assert.equal((await room()).outcome, 3);
    const waiting = await send(accounts[0], 'createMatch', [1]);
    const waitingId = parseEventLogs({ abi, logs: waiting.logs, eventName: 'MatchCreated' })[0].args
      .matchId;
    const waitingRoom = () =>
      chain.readContract({
        address: deployment.arenaAddress,
        abi,
        functionName: 'getMatch',
        args: [waitingId],
      });
    await rpc(deployment.rpcUrl, 'arena_advanceClock', [
      `0x${((await waitingRoom()).joinDeadline + 1n).toString(16)}`,
    ]);
    await waitFor(
      async () => (await waitingRoom()).phase === 7,
      'Geth Keeper did not expire the waiting room.',
    );
    passed(
      'the separately funded Geth Keeper settles browser orders, finalizes timeouts and expires waiting rooms with real transactions',
    );
  } finally {
    for (const page of pages) await page.context().close();
  }
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = true;
    keeper?.stdin.end();
    void browser?.close();
  });

try {
  await requirePreviewDeployment(root, deployment);
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
  const nodePID = await readFile(resolve(root, nodeFile), 'utf8');
  const sync = (await api('/sync')).sync;
  const oldHash = acceptance.matches[0].source.transactionHash;
  const oldReceipt = await chain.getTransactionReceipt({ hash: oldHash });
  const oldLogs = await chain.getLogs({
    address: deployment.arenaAddress,
    fromBlock: BigInt(deployment.deploymentBlock),
    toBlock: oldReceipt.blockNumber,
  });
  const oldTransaction = await api(`/transactions/${oldHash}`);
  const historical = archive ? await historicalAccounts(accounts) : [];
  const oldReplay = archive
    ? await api(`/matches/${acceptance.matches[0].id}/replay?limit=100`)
    : undefined;
  const legacy = archive ? await json('client/public/legacy-deployment.json') : undefined;
  const legacyReport = archive ? await json('.local/indexer/anvil-acceptance.json') : undefined;
  const legacyPath = legacy
    ? `/matches/${legacyReport.matches[0].id}/replay?limit=100&deployment=${legacy.deploymentHash}`
    : undefined;
  const legacyReplay = legacy ? await api(legacyPath) : undefined;
  const baseline = await chain.readContract({
    address: deployment.arenaAddress,
    abi,
    functionName: 'getBattleState',
    args: [BigInt(acceptance.matches[0].id)],
    blockNumber: oldReceipt.blockNumber,
  });
  const acknowledged = archive ? await json('.local/archive/confirmed.json') : undefined;
  if (archive) {
    assert.match(await rpc(deployment.rpcUrl, 'web3_clientVersion'), /geth\//i);
    console.log(
      'Deliberately sending SIGKILL to the actual isolated Geth process after an acknowledged Commit.',
    );
    process.kill(Number(nodePID), 'SIGKILL');
    passed('killed the actual Geth node after its acknowledged Commit receipt');
  }
  await request('reload-chain');
  await waitFor(async () => {
    if ((await readFile(resolve(root, nodeFile), 'utf8').catch(() => nodePID)) === nodePID)
      return false;
    const response = await fetch(backend + '/sync').catch(() => undefined);
    if (!response?.ok) return false;
    const state = (await response.json()).sync;
    return state.ready && state.processId !== sync.processId;
  }, 'The saved chain and Go service did not recover.');
  const restored = await json('client/public/deployment.json');
  if (archive)
    assert.deepEqual(
      await json('.local/archive/confirmed.json'),
      acknowledged,
      'Geth must recover the exact previously acknowledged head.',
    );
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
  if (archive) {
    assert.deepEqual(
      await historicalAccounts(accounts),
      historical,
      'Historical account states changed after Geth SIGKILL.',
    );
    assert.deepEqual(
      (await api(`/matches/${acceptance.matches[0].id}/replay?limit=100`)).items,
      oldReplay.items,
    );
    assert.equal((await api(legacyPath)).verification.status, 'Verified');
    assert.deepEqual((await api(legacyPath)).items, legacyReplay.items);
    report.requirements['historical-accounts'] = 'passed';
    report.historicalAccounts = historical;
    passed(
      'Geth genesis and deployment-block balances, nonces, code and storage survive SIGKILL and match the account API',
    );
  }
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
  if (archive) {
    await page.goto(`${base}/history/${acceptance.matches[0].id}`);
    await page.locator('[data-verification="Verified"]').waitFor();
    await page.getByRole('combobox', { name: 'Playback speed' }).selectOption('0.5');
    await page.getByRole('button', { name: 'Play replay', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('.replay-screen')?.getAttribute('data-animating') === 'true',
    );
    await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
    await page.goto(
      `${base}/history/${legacyReport.matches[0].id}?deployment=${legacy.deploymentHash}`,
    );
    await page.locator('[data-verification="Verified"]').waitFor();
    await page.goto(
      `${base}/transactions/${legacy.transactionHash}?deployment=${legacy.deploymentHash}`,
    );
    await page
      .getByRole('heading', { name: 'Transaction receipt · Succeeded', exact: true })
      .waitFor();
    passed(
      'Geth replay animates and old Anvil replay and receipt routes retain their original deployment source',
    );
  }
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
  const manifest = await json(manifestFile);
  if (archive) {
    assert.deepEqual(
      (await api(`/matches/${acceptance.matches[0].id}/replay?limit=100`)).items,
      oldReplay.items,
    );
    assert.deepEqual((await api(legacyPath)).items, legacyReplay.items);
    for (const source of [deployment, legacy]) {
      const comparison = await json(`.local/indexer/reindex-${source.deploymentHash}.json`);
      assert.equal(
        comparison.matched,
        true,
        'Every history source must survive an empty-projection rebuild.',
      );
    }
    const exported = await json(`.local/archive/blocks/${oldReceipt.blockNumber}.json`);
    assert.equal(exported.header.hash, oldReceipt.blockHash);
    assert.ok(
      exported.receipts.some(
        (entry) => entry.transactionHash.toLowerCase() === oldHash.toLowerCase(),
      ),
    );
    assert.ok(
      exported.transactions.some((entry) => entry.hash.toLowerCase() === oldHash.toLowerCase()),
    );
    assert.equal(manifest.deployment.rulesHash, deployment.rulesHash);
    assert.equal(manifest.vectors['state-vectors'].rulesHash, deployment.rulesHash);
    report.requirements['history-archive'] = 'passed';
    passed(
      'Geth block and receipt exports, frozen rules, old history sources and independently verified replay survive complete reindexing',
    );
    const sourceFile = resolve(root, 'contracts/src/Arena.sol');
    const currentSource = await readFile(sourceFile, 'utf8');
    try {
      await writeFile(
        sourceFile,
        '// Current working source intentionally differs from the archived deployment.\n',
      );
      const sourceResult = await compileArchivedSources(root, manifest);
      assert.equal(sourceResult.status, 'Matched');
    } finally {
      await writeFile(sourceFile, currentSource);
    }
    const altered = structuredClone(manifest);
    altered.compilerInput.sources['src/Arena.sol'].content +=
      '\n// Intentionally altered archived source.\n';
    await assert.rejects(compileArchivedSources(root, altered), /do not reproduce/);
    report.requirements['source-reproduction'] = 'passed';
    passed(
      'the restored old Geth deployment recompiles from frozen sources despite changed working files, and altered archived sources are rejected',
    );
    await persistenceFailure(browser);
    report.requirements['confirmed-recovery'] = 'passed';
    keeper.stdin.end();
    await keeperExit;
    keeper = undefined;
    await keeperProgression(browser, accounts);
    const gameplay = await json('.local/browser/gameplay-geth.json');
    assert.equal(gameplay.status, 'passed');
    assert.equal(gameplay.engine, 'geth');
    for (const requirement of [
      'confirmed-recovery',
      'history-archive',
      'source-reproduction',
      'historical-accounts',
    ])
      assert.equal(
        report.requirements[requirement],
        'passed',
        `Missing Geth acceptance: ${requirement}`,
      );
  }
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
  await writeFile(
    resolve(root, `.local/browser/persistence-${engine}.json`),
    JSON.stringify(report, null, 2) + '\n',
  );
}
