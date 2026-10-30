import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { createPublicClient, getAddress, http, parseEventLogs, toFunctionSelector } from 'viem';
import { anvil } from 'viem/chains';
import { installedBrowser } from './browser.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = resolve(root, '.local/browser');
const base = 'http://127.0.0.1:5174';
const backend = `http://${process.env.HTTP_ADDRESS || '127.0.0.1:18081'}`;
const binary = resolve(root, '.local/bin/arena-server');
const run = promisify(execFile);
const acceptance = JSON.parse(
  await readFile(resolve(root, '.local/indexer/acceptance.json'), 'utf8'),
);
assert.equal(acceptance.status, 'passed', 'Backend acceptance must pass before browser gameplay.');
const deployment = JSON.parse(
  await readFile(resolve(root, 'client/public/deployment.json'), 'utf8'),
);
const { abi } = JSON.parse(
  await readFile(resolve(root, 'contracts/out/Arena.sol/Arena.json'), 'utf8'),
);
const chain = createPublicClient({
  chain: anvil,
  transport: http(deployment.rpcUrl),
  cacheTime: 0,
});
const contract = { abi, address: deployment.arenaAddress };
const selectors = Object.fromEntries(
  abi
    .filter((item) => item.type === 'function')
    .map((item) => [item.name, toFunctionSelector(item)]),
);
const report = {
  status: 'running',
  checks: [],
  viewports: [],
  receipts: [],
  errors: [],
  startedAt: new Date().toISOString(),
};
const players = [];
let browser, server, original, baseline, keeper, keeperExited, keeperError;
let keeperHeld = false,
  interrupted = false,
  cleaning = false,
  apiOffline = false;
const streams = new Set();
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const read = (functionName, args = []) => chain.readContract({ ...contract, functionName, args });
const plain = (value) =>
  JSON.parse(
    JSON.stringify(value, (_, entry) => (typeof entry === 'bigint' ? Number(entry) : entry)),
  );

async function waitFor(check, message, timeout = 35_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (interrupted && !cleaning) throw new Error('Browser gameplay interrupted.');
    if (await check()) return;
    await pause(100);
  }
  throw new Error(message);
}
function passed(name) {
  report.checks.push(name);
  console.log(`PASS: browser ${name}.`);
}
async function api(path) {
  const response = await fetch(`${backend}${path}`, { signal: AbortSignal.timeout(35_000) });
  assert.equal(response.status, 200, `API ${path}`);
  return response.json();
}
async function ready() {
  const block = await chain.getBlock();
  await waitFor(async () => {
    try {
      const response = await fetch(`${backend}/ready`, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return false;
      const meta = await response.json();
      return meta.deploymentHash === acceptance.deploymentHash && meta.indexedHash === block.hash;
    } catch {
      return false;
    }
  }, 'Indexer did not catch up with browser gameplay.');
}
async function databaseState() {
  const { stdout } = await run(binary, ['browser-fault', 'database-state'], {
    cwd: resolve(root, 'server'),
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}
async function createPlayer(index, account) {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 760 },
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
    reducedMotion: 'no-preference',
  });
  const player = {
    index,
    account,
    context,
    offline: false,
    receiptBlocked: false,
    failSends: 0,
    blockReveal: false,
    writes: [],
  };
  await context.route(deployment.rpcUrl, async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    const body = request.postDataJSON();
    const transaction = body.method === 'eth_sendTransaction' ? body.params[0] : undefined;
    const data = transaction?.data ?? transaction?.input ?? '';
    if (transaction) player.writes.push({ selector: data.slice(0, 10), from: transaction.from });
    const failed =
      player.offline ||
      (player.receiptBlocked && body.method === 'eth_getTransactionReceipt') ||
      (transaction && player.blockReveal && data.startsWith(selectors.revealActions)) ||
      (transaction && player.failSends > 0);
    if (transaction && player.failSends > 0) player.failSends--;
    if (!failed) return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32000, message: 'Controlled browser RPC interruption' },
      }),
    });
  });
  player.page = await context.newPage();
  player.page.setDefaultTimeout(35_000);
  player.page.on('pageerror', (error) => report.errors.push(error.message));
  players.push(player);
  await lobby(player);
  return player;
}
async function lobby(player) {
  await player.page.goto(base);
  const selector = player.page.getByLabel('Active account', { exact: true });
  await waitFor(() => selector.isEnabled(), 'The local account selector did not connect.');
  await selector.selectOption(player.account);
}
async function confirm(player) {
  const button = player.page.getByRole('button', { name: 'Confirm orders', exact: true });
  await waitFor(() => button.isEnabled(), 'Squad confirmation did not become available.');
  await button.click();
  const dialog = player.page.getByRole('dialog', { name: 'Confirm orders?', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
}
async function createMatch({ uncertain = false } = {}) {
  const [host, guest] = players;
  await lobby(host);
  await lobby(guest);
  host.receiptBlocked = uncertain;
  const before = host.writes.length;
  await host.page.getByRole('button', { name: 'Create room', exact: true }).click();
  if (uncertain) {
    const check = host.page.getByRole('button', { name: 'Check confirmation', exact: true });
    await check.waitFor();
    assert.equal(host.writes.length, before + 1, 'Only one creation may be broadcast.');
    assert.equal(await host.page.locator('.create-panel button').isDisabled(), true);
    await check.click();
    await check.waitFor();
    assert.equal(host.writes.length, before + 1, 'Checking a receipt must never rebroadcast.');
    host.receiptBlocked = false;
    await check.click();
  }
  await host.page.waitForURL(/\/rooms\/\d+$/);
  const id = BigInt(new URL(host.page.url()).pathname.split('/').pop());
  const start = host.page.getByRole('button', { name: 'Start game', exact: true });
  assert.equal(
    await start.isDisabled(),
    true,
    'Host start stays visible before the opponent joins.',
  );
  await host.page.bringToFront();
  await host.page.getByRole('button', { name: 'Copy invitation', exact: true }).click();
  const invitation = await host.page.evaluate(() => navigator.clipboard.readText());
  assert.equal(invitation, `${base}/rooms/${id}`);
  await guest.page.bringToFront();
  await guest.page.getByLabel('Room ID or invitation link', { exact: true }).fill(invitation);
  await guest.page.getByRole('button', { name: 'View room', exact: true }).click();
  await guest.page.getByRole('button', { name: 'Join room', exact: true }).click();
  await waitFor(() => start.isEnabled(), 'Host start did not unlock after the opponent joined.');
  assert.equal((await read('getMatch', [id])).phase, 1, 'Joining must not start the match.');
  assert.equal(
    await guest.page.getByRole('button', { name: 'Start game', exact: true }).count(),
    0,
  );
  for (const { page } of players)
    assert.equal(
      await page.locator('#active-account').count(),
      0,
      'Room accounts must be read-only.',
    );
  await start.click();
  for (const { page } of players) {
    await page.waitForURL(new RegExp(`/rooms/${id}/battle$`));
    await page.locator('.renderer[data-ready="true"]').waitFor();
  }
  return id;
}
async function order(player, slot, action) {
  if (action.kind === 0) return;
  const names = ['Guardian', 'Ranger', 'Scout'];
  const actions = ['Hold', 'Move', 'Attack', 'Shield', 'Power shot', 'Dash'];
  await player.page
    .locator('.squad')
    .getByRole('button', { name: new RegExp(`^${names[slot]},`) })
    .click();
  const drawer = player.page.getByRole('dialog', { name: names[slot], exact: true });
  await drawer.getByRole('button', { name: new RegExp(`^${actions[action.kind]}`) }).click();
  if ([1, 2, 4, 5].includes(action.kind)) {
    const target = [1, 5].includes(action.kind)
      ? action.path[action.pathLength - 1]
      : action.targetCell;
    const cell = player.page.locator(`[data-cell="${target}"]`);
    await cell.focus();
    await cell.press('Enter');
    await player.page
      .locator('[aria-label="Confirm target selection"]')
      .getByRole('button', { name: 'Confirm', exact: true })
      .click();
  } else await drawer.getByRole('button', { name: 'Confirm order', exact: true }).click();
  await drawer.getByRole('button', { name: 'Close unit details', exact: true }).click();
}
async function plan(player, actions) {
  await waitFor(
    () => player.page.getByRole('button', { name: 'Confirm orders', exact: true }).isEnabled(),
    'The next round did not become editable.',
  );
  for (let slot = 0; slot < 3; slot++) await order(player, slot, actions[slot]);
}
async function committed(id, player) {
  await waitFor(
    async () => (await read('getRoundStatus', [id])).committed[player],
    'The UI confirmation did not reach the contract.',
  );
}
async function backup(player, file, password, error) {
  await player.page.getByRole('button', { name: 'Orders backup', exact: true }).click();
  const dialog = player.page.getByRole('dialog', { name: 'Orders backup', exact: true });
  await dialog.getByLabel('Backup password', { exact: true }).fill(password);
  await dialog.getByLabel('Encrypted backup file', { exact: true }).setInputFiles(file);
  await dialog.getByRole('button', { name: 'Import original orders', exact: true }).click();
  if (error) await dialog.getByRole('alert').filter({ hasText: error }).waitFor();
  else
    await dialog
      .getByText('Original orders restored. Close this window to continue.', { exact: true })
      .waitFor();
  await dialog.getByRole('button', { name: 'Close backup', exact: true }).click();
}
async function checkViewports() {
  const [host, guest] = players;
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1000, height: 640 },
    { width: 390, height: 844 },
  ]) {
    for (const player of players) {
      await player.page.setViewportSize(viewport);
      await player.page
        .locator('.squad')
        .getByRole('button', { name: /^Scout,/ })
        .click();
      const layout = await player.page.locator('.drawer-panel').evaluate((panel) => {
        const rect = panel.getBoundingClientRect();
        const close = panel.querySelector('.dismiss').getBoundingClientRect();
        const board = document.querySelector('.board-space').getBoundingClientRect();
        return {
          width: innerWidth,
          height: innerHeight,
          left: rect.left,
          right: rect.right,
          panelWidth: rect.width,
          scrollWidth: panel.scrollWidth,
          clientWidth: panel.clientWidth,
          panelBottom: rect.bottom,
          closeLeft: close.left,
          closeRight: close.right,
          boardWidth: board.width,
          boardHeight: board.height,
          pageWidth: document.documentElement.scrollWidth,
        };
      });
      assert.ok(
        layout.panelWidth < viewport.width / 4,
        'Unit details must remain a small side drawer.',
      );
      assert.ok(
        player === host ? layout.left < 16 : layout.right > viewport.width - 16,
        'Drawers follow each unit birth side.',
      );
      assert.ok(
        layout.closeLeft >= layout.left && layout.closeRight <= layout.right,
        'Close button must remain inside the drawer.',
      );
      assert.ok(
        layout.scrollWidth <= layout.clientWidth + 1,
        'Drawer contents must not overflow horizontally.',
      );
      assert.ok(layout.panelBottom <= viewport.height && layout.pageWidth <= viewport.width + 1);
      assert.ok(
        layout.boardWidth > 0 && layout.boardHeight > 160,
        'Controls must leave usable space for the complete board.',
      );
      await player.page.keyboard.press('Escape');
      assert.equal(
        await player.page.getByRole('dialog').count(),
        0,
        'Escape must close the unit drawer.',
      );
    }
    report.viewports.push({ ...viewport, browser: report.browser });
  }
  for (const player of [host, guest])
    await player.page.setViewportSize({ width: 1100, height: 760 });
  passed(
    'desktop, editor-sized and phone-sized viewports keep the board, birth-side drawer, close control and keyboard dismissal usable',
  );
}
async function recovery(id) {
  const [host, guest] = players;
  const controls = host.page.getByRole('region', { name: 'Round controls' });
  const before = host.writes.length;
  await host.page.getByRole('button', { name: 'Confirm orders', exact: true }).click();
  const confirmation = host.page.getByRole('dialog', { name: 'Confirm orders?', exact: true });
  await confirmation.waitFor();
  await confirmation
    .locator('.confirmation-actions')
    .getByRole('button', { name: 'Keep editing', exact: true })
    .click();
  assert.equal(host.writes.length, before, 'Cancelling the reminder must not submit anything.');
  host.failSends = 1;
  await confirm(host);
  await host.page.getByRole('button', { name: 'Retry confirmation', exact: true }).waitFor();
  assert.equal((await read('getRoundStatus', [id])).committed[0], false);
  await host.page.getByRole('button', { name: 'Retry confirmation', exact: true }).click();
  await committed(id, 0);
  const writesAfterCommit = host.writes.length;
  await host.page.reload();
  await host.page.getByText('Orders confirmed', { exact: true }).waitFor();
  assert.equal(
    host.writes.length,
    writesAfterCommit,
    'Reload must restore orders without broadcasting a new Commit.',
  );
  await host.page.getByRole('button', { name: 'Orders backup', exact: true }).click();
  let dialog = host.page.getByRole('dialog', { name: 'Orders backup', exact: true });
  const password = 'local acceptance backup';
  const refreshed = host.page.waitForResponse((response) => {
    const request = response.request();
    if (response.url() !== new URL(deployment.rpcUrl).href || request.method() !== 'POST')
      return false;
    const body = request.postDataJSON();
    return body.method === 'eth_call' && body.params[0].data?.startsWith(selectors.getRoundStatus);
  });
  await dialog.getByLabel('Backup password', { exact: true }).fill(password);
  assert.equal(
    (await (await refreshed).json()).error,
    undefined,
    'The ordinary RPC refresh must succeed.',
  );
  await waitFor(
    () => host.page.locator('button[aria-label="Refresh chain state"]').isEnabled(),
    'The ordinary battlefield refresh did not finish.',
  );
  assert.equal(
    await dialog.isVisible(),
    true,
    'Ordinary refresh must keep the backup dialog open.',
  );
  assert.equal(await dialog.getByLabel('Backup password', { exact: true }).inputValue(), password);
  passed('ordinary RPC refresh preserves the open backup dialog and its password input');
  const download = host.page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export encrypted backup', exact: true }).click();
  const path = resolve(output, 'gameplay-backup.json');
  await (await download).saveAs(path);
  const encrypted = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(encrypted.cipher, 'AES-GCM');
  assert.equal(encrypted.actions, undefined, 'Backup must not contain plaintext orders.');
  assert.equal(encrypted.salt.length > 0, true);
  await dialog.getByRole('button', { name: 'Close backup', exact: true }).click();
  await backup(guest, path, password, /do not match/);
  await host.page.evaluate(async () => {
    const database = await new Promise((done, fail) => {
      const request = indexedDB.open('arena-orders', 1);
      request.onsuccess = () => done(request.result);
      request.onerror = () => fail(request.error);
    });
    await new Promise((done, fail) => {
      const transaction = database.transaction('secrets', 'readwrite');
      transaction.objectStore('secrets').clear();
      transaction.oncomplete = done;
      transaction.onerror = () => fail(transaction.error);
    });
    database.close();
  });
  await host.page.reload();
  await host.page.getByRole('alert').filter({ hasText: 'Original orders are missing' }).waitFor();
  await backup(host, path, 'incorrect password', /Cannot unlock/);
  await backup(host, path, password);
  await host.page.getByText('Orders confirmed', { exact: true }).waitFor();
  assert.equal(
    (await read('getRoundStatus', [id])).committed[1],
    false,
    'Importing a foreign backup must not confirm another account.',
  );
  assert.equal(await controls.count(), 1);
  passed(
    'cancel, failed-send retry, saved-order refresh, encrypted export, missing-secret recovery, wrong password and account isolation',
  );
  return { path, password };
}
async function roundDone(id, round, expected) {
  await waitFor(
    async () => {
      const room = await read('getMatch', [id]);
      return room.round > round || room.outcome !== 0;
    },
    `The real UI round ${round} did not finish.`,
    60_000,
  );
  if (expected)
    assert.deepEqual(
      plain(await read('getBattleState', [id])),
      expected,
      `Round ${round} state must match the reference game.`,
    );
}
async function verifyMatch(id, outcome, reason) {
  await ready();
  const replay = await api(`/matches/${id}/replay?limit=100`);
  assert.equal(replay.match.outcome, outcome);
  assert.equal(replay.match.reason, reason);
  assert.equal(
    replay.verification.status,
    'Verified',
    'Actual UI transactions must independently replay to the chain state.',
  );
  const logs = await chain.getContractEvents({
    ...contract,
    fromBlock: BigInt(deployment.deploymentBlock),
    toBlock: 'latest',
  });
  const hashes = new Set(
    logs.filter((log) => log.args.matchId === id).map((log) => log.transactionHash),
  );
  for (const hash of hashes) {
    const receipt = await chain.getTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    const transaction = await chain.getTransaction({ hash });
    assert.ok(
      players.some((player) => player.account.toLowerCase() === transaction.from.toLowerCase()),
      'Gameplay must come from the selected browser accounts.',
    );
    report.receipts.push({
      match: id.toString(),
      hash,
      block: receipt.blockNumber.toString(),
      from: transaction.from,
    });
  }
  const commits = parseEventLogs({ abi, logs, eventName: 'ActionCommitted' }).filter(
    (event) => event.args.matchId === id,
  );
  const expectedCommits =
    reason === 5 ? (outcome === 3 ? 0 : 1) : reason === 6 ? 2 : replay.match.round * 2;
  assert.equal(commits.length, expectedCommits);
  assert.equal(
    new Set(commits.map((event) => `${event.args.round}:${event.args.player}`)).size,
    commits.length,
    'Each player must commit only once per round.',
  );
  return replay;
}
async function play(reference, saved) {
  const id = await createMatch({ uncertain: reference.name === 'points' });
  if (reference.name === 'points') {
    await checkViewports();
    saved = await recovery(id);
  } else await backup(players[0], saved.path, saved.password, /do not match/);
  for (const round of reference.rounds) {
    if (reference.name !== 'points' || round.round !== 1) {
      for (const player of players) await plan(player, round.orders[player.index]);
      if (reference.name === 'points' && round.round === 2) {
        await backup(players[0], saved.path, saved.password, /do not match/);
        const host = players[0];
        host.offline = true;
        await host.page
          .getByRole('alert')
          .filter({ hasText: /local chain|local backend|Could not complete/i })
          .first()
          .waitFor();
        assert.ok(
          (await host.page.locator('.squad').innerText()).includes('Dash'),
          'RPC failure must retain the selected squad draft.',
        );
        assert.equal(
          await host.page.getByRole('button', { name: 'Confirm orders', exact: true }).isDisabled(),
          true,
        );
        host.offline = false;
        await waitFor(
          () => host.page.getByRole('button', { name: 'Confirm orders', exact: true }).isEnabled(),
          'RPC recovery did not restore confirmation.',
        );
        assert.ok((await host.page.locator('.squad').innerText()).includes('Dash'));
        passed(
          'RPC loss retains the room and draft, disables submission, and recovers without losing the planned route',
        );
      }
      const receiptInterrupted = reference.name === 'points' && round.round === 2;
      players[0].receiptBlocked = receiptInterrupted;
      const before = players[0].writes.length;
      await confirm(players[0]);
      if (receiptInterrupted) {
        const check = players[0].page.getByRole('button', {
          name: 'Check confirmation',
          exact: true,
        });
        await check.waitFor();
        players[0].receiptBlocked = false;
        await check.click();
        await players[0].page.getByText('Orders confirmed', { exact: true }).waitFor();
        assert.equal(
          players[0].writes.length,
          before + 1,
          'Receipt recovery must keep the original single Commit.',
        );
        passed(
          'battle receipt recovery checks the original hash and never resubmits the locked squad',
        );
      }
      await committed(id, 0);
    }
    await confirm(players[1]);
    const expected = reference.snapshots.find(
      (snapshot) => snapshot.stateHash === round.afterHash,
    )?.state;
    assert.ok(expected, 'The existing acceptance must provide a real expected round snapshot.');
    await roundDone(id, round.round, expected);
  }
  apiOffline = false;
  await verifyMatch(id, reference.state.outcome, reference.state.reason);
  for (const player of players) {
    await player.page.getByRole('link', { name: 'View replay', exact: true }).click();
    await player.page.locator('[data-verification="Verified"]').waitFor();
  }
  passed(
    `two independent local accounts complete ${reference.name} through real UI controls, receipts, round states and verified history`,
  );
  return saved;
}
async function timeout(phase, bothMissing = false) {
  const id = await createMatch();
  players[0].blockReveal = phase === 3 && bothMissing;
  players[1].blockReveal = phase === 3;
  if (phase === 3 || !bothMissing) {
    await confirm(players[0]);
    await committed(id, 0);
  }
  if (phase === 3) {
    await confirm(players[1]);
    await waitFor(
      async () => (await read('getMatch', [id])).phase === 3,
      'Both UI confirmations must open the Reveal phase.',
    );
    if (!bothMissing)
      await waitFor(
        async () => (await read('getRoundStatus', [id])).revealed[0],
        'Player A did not reveal through the browser.',
      );
  }
  const status = await read('getRoundStatus', [id]);
  assert.deepEqual([...status.committed], phase === 3 ? [true, true] : [!bothMissing, false]);
  assert.deepEqual([...status.revealed], [phase === 3 && !bothMissing, false]);
  const room = await read('getMatch', [id]);
  assert.equal(room.phase, phase);
  await chain.request({
    method: 'evm_setNextBlockTimestamp',
    params: [Number(room.phaseDeadline) + 1],
  });
  await chain.request({ method: 'evm_mine', params: [] });
  await players[0].page.getByRole('button', { name: 'Refresh chain state', exact: true }).click();
  const finalize = players[0].page.getByRole('button', { name: 'Finalize timeout', exact: true });
  await waitFor(
    () => finalize.isEnabled(),
    'Expired phases must expose a usable manual timeout control.',
  );
  await finalize.click();
  await roundDone(id, 1);
  players[0].blockReveal = false;
  players[1].blockReveal = false;
  await verifyMatch(id, bothMissing ? 3 : 1, phase === 2 ? 5 : 6);
  const result = bothMissing ? 'Draw' : 'Player A wins';
  for (const { page } of players)
    await page.locator('.result').getByText(result, { exact: true }).waitFor();
  passed(
    `${phase === 2 ? 'Commit' : 'Reveal'} timeout ${bothMissing ? 'draw' : 'win'} completes through the UI and independently verifies the on-chain result`,
  );
}

await mkdir(output, { recursive: true });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = true;
    void browser?.close();
  });
try {
  const executablePath = await installedBrowser();
  const assets = resolve(root, 'client/dist/assets');
  report.chunks = await Promise.all(
    (await readdir(assets))
      .filter((file) => file.endsWith('.js'))
      .map(async (file) => ({
        file,
        bytes: (await stat(resolve(assets, file))).size,
      })),
  );
  for (const chunk of report.chunks)
    assert.ok(chunk.bytes <= 500_000, `${chunk.file} still exceeds the 500 kB chunk budget.`);
  passed('production JavaScript chunks stay within the unchanged 500 kB budget');
  keeper = spawn(binary, ['browser-fault', 'hold-keeper'], {
    cwd: resolve(root, 'server'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  keeperExited = new Promise((done) => keeper.once('close', done));
  keeper.on('error', (error) => {
    keeperError = error;
  });
  keeper.stdout.on('data', () => {
    keeperHeld = true;
  });
  keeper.stderr.on('data', (data) => process.stderr.write(data));
  await waitFor(() => {
    if (keeperError) throw keeperError;
    if (keeper.exitCode !== null)
      throw new Error('Could not hold Keeper for controlled UI acceptance.');
    return keeperHeld;
  }, 'Keeper acceptance lock was not acquired.');
  await ready();
  baseline = await databaseState();
  original = await chain.request({ method: 'evm_snapshot' });
  server = await preview({
    root: resolve(root, 'client'),
    configFile: resolve(root, 'client/vite.config.js'),
    preview: { host: '127.0.0.1', port: 5174, strictPort: true },
    plugins: [
      {
        name: 'gameplay-api-outage',
        configurePreviewServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith('/api/')) return next();
            if (apiOffline) {
              res.writeHead(503, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ message: 'Controlled history API interruption' }));
              return;
            }
            if (req.url.split('?')[0] === '/api/events') {
              streams.add(res);
              res.on('close', () => streams.delete(res));
            }
            next();
          });
        },
      },
    ],
  });
  browser = await chromium.launch({ headless: true, executablePath });
  report.browser = browser.version();
  const accounts = await chain.request({ method: 'eth_accounts' });
  await createPlayer(0, getAddress(accounts[0]));
  await createPlayer(1, getAddress(accounts[1]));
  const points = acceptance.matches.find((match) => match.name === 'points');
  const elimination = acceptance.matches.find((match) => match.name === 'elimination');
  assert.ok(points && elimination, 'Existing public acceptance games supply the UI plans.');
  apiOffline = true;
  for (const response of streams) response.destroy();
  const saved = await play(points);
  passed(
    'API and SSE outage permits RPC room creation, invitation join, manual host start and a complete points game; history recovers afterward',
  );
  await play(elimination, saved);
  await timeout(2);
  await timeout(3);
  await timeout(2, true);
  await timeout(3, true);
  assert.deepEqual(report.errors, [], 'Uncaught browser errors');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack || String(error);
  process.exitCode = 1;
  console.error(`Browser gameplay acceptance failed: ${error.message}`);
  for (const player of players)
    if (!player.page.isClosed())
      await player.page
        .screenshot({
          path: resolve(output, `gameplay-failure-${player.index}.png`),
          fullPage: true,
          timeout: 5_000,
        })
        .catch(() => {});
} finally {
  cleaning = true;
  apiOffline = false;
  await browser?.close();
  try {
    if (original) {
      assert.equal(
        await chain.request({ method: 'evm_revert', params: [original] }),
        true,
        'Restore browser gameplay chain.',
      );
      await ready();
      assert.deepEqual(
        (await databaseState()).records,
        baseline.records,
        'Gameplay cleanup must restore the original indexed records.',
      );
      passed('gameplay cleanup restores the original chain, rooms, clock and indexed records');
    }
  } catch (error) {
    report.status = 'failed';
    report.cleanupError = error.message;
    process.exitCode = 1;
    console.error(`Browser gameplay cleanup failed: ${error.message}`);
  }
  if (keeper) {
    keeper.stdin.end();
    await keeperExited;
  }
  for (const response of streams) response.destroy();
  await server?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'gameplay.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'passed')
    console.log(
      'PASS: real browser gameplay and recovery acceptance completed. Local gameplay report saved.',
    );
}
