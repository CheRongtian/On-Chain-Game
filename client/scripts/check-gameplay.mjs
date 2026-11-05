import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { preview } from 'vite';
import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  parseTransaction,
  recoverTransactionAddress,
  toFunctionSelector,
} from 'viem';
import { anvil } from 'viem/chains';
import {
  browserTypes,
  installedBrowser,
  replayState,
  requirePreviewDeployment,
  transactionState,
  waitForReceiptRecovery,
  waitForVerifiedReplay,
} from './browser.mjs';

const browserPort = Number(process.env.ARENA_BROWSER_PORT || 5174);
const browserName = process.argv[2] || 'chromium';
const browserType = browserTypes[browserName];
assert.ok(browserType, `Unsupported gameplay browser: ${browserName}`);
const root = fileURLToPath(new URL('../..', import.meta.url));
const output = resolve(root, '.local/browser');
const screenshots = resolve(output, browserName);
const base = `http://127.0.0.1:${browserPort}`;
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
const rpcEndpoint = new URL(deployment.rpcUrl).href;
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
  engine: deployment.engine ?? 'anvil',
  status: 'running',
  browserName,
  checks: [],
  viewports: [],
  receipts: [],
  timings: { indexing: [], verification: [], matches: [], rounds: [], interactions: [] },
  measurementScope: {
    confirmation:
      'signed broadcast to the successful receipt response, grouped by scripted conditions',
    indexing: 'captured chain head through readiness at that same canonical block',
    verification: 'one replay HTTP request and JSON decode after index catch-up',
    match:
      'room creation through final settlement; scripted planning, setup and deliberate faults included',
    play: 'confirmed host start and board readiness through final settlement',
    round: 'planning through the observed settled state; no post-game replay inspection',
    inspection: 'post-settlement verification and replay controls, measured separately',
  },
  replayChecks: { attempted: 0, verified: 0 },
  errors: [],
  screenshots: [],
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
  console.log(`PASS: ${browserName} gameplay ${name}.`);
}
function requireNoGameplayFaults() {
  assert.equal(apiOffline, false, 'Normal gameplay requires the history API to be available.');
  for (const player of players) {
    assert.ok(
      !player.offline &&
        !player.wrongChain &&
        !player.receiptBlocked &&
        !player.blockReveal &&
        !player.snapshotGate &&
        player.failSends === 0,
      'A fault from the preceding scenario is still active.',
    );
  }
}
async function api(path) {
  const response = await fetch(`${backend}${path}`, { signal: AbortSignal.timeout(35_000) });
  assert.equal(response.status, 200, `API ${path}`);
  return response.json();
}
async function ready() {
  const started = performance.now();
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
  report.timings.indexing.push({
    block: block.number.toString(),
    durationMilliseconds: Math.round(performance.now() - started),
  });
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
    permissions: browserName === 'chromium' ? ['clipboard-read', 'clipboard-write'] : [],
    reducedMotion: 'no-preference',
  });
  // Observe successful real writes without requiring browser-specific clipboard-read permissions.
  await context.addInitScript(() => {
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (text) => {
      window.arenaInvitationCopy = { status: 'pending' };
      try {
        await write(text);
        window.arenaInvitationCopy = { status: 'copied', text };
      } catch (error) {
        window.arenaInvitationCopy = {
          status: 'failed',
          error: `${error.name}: ${error.message}`,
        };
        throw error;
      }
    };
  });
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === base && url.pathname.startsWith('/api/') && request.method() !== 'GET')
      report.errors.push('Player data was sent to the read-only history API.');
  });
  const player = {
    index,
    account,
    context,
    offline: false,
    wrongChain: false,
    receiptBlocked: false,
    failSends: 0,
    blockReveal: false,
    snapshotGate: undefined,
    snapshotHeld: false,
    writes: [],
    receiptReads: [],
  };
  await context.route(deployment.rpcUrl, async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    const body = request.postDataJSON();
    if (body.method === 'eth_getTransactionReceipt') player.receiptReads.push(body.params[0]);
    if (player.wrongChain && body.method === 'eth_chainId')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x1' }),
      });
    if (
      player.snapshotGate &&
      body.method === 'eth_call' &&
      body.params[0].data?.startsWith(selectors.getRoundStatus)
    ) {
      player.snapshotHeld = true;
      await player.snapshotGate;
    }
    const nodeSigning =
      body.method === 'eth_sendTransaction' || body.method === 'wallet_sendTransaction';
    if (nodeSigning) report.errors.push('Browser gameplay requested node-managed signing.');
    const serializedTransaction =
      body.method === 'eth_sendRawTransaction' ? body.params[0] : undefined;
    const transaction = serializedTransaction ? parseTransaction(serializedTransaction) : undefined;
    const data = transaction?.data ?? '';
    if (transaction)
      player.writes.push({
        hash: keccak256(serializedTransaction),
        selector: data.slice(0, 10),
        from: await recoverTransactionAddress({ serializedTransaction }),
        chainId: transaction.chainId,
        conditions: report.scenario?.conditions,
        startedAt: performance.now(),
      });
    const failed =
      player.offline ||
      nodeSigning ||
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
        error: {
          code: -32000,
          message: nodeSigning
            ? 'Browser gameplay requires local wallet signing.'
            : 'Controlled browser RPC interruption',
        },
      }),
    });
  });
  context.on('response', async (response) => {
    if (response.url() !== rpcEndpoint || response.request().method() !== 'POST') return;
    try {
      if (response.request().postDataJSON().method !== 'eth_getTransactionReceipt') return;
      const receipt = (await response.json()).result;
      if (receipt?.status !== '0x1') return;
      const signed = player.writes.findLast((write) => write.hash === receipt.transactionHash);
      if (signed && signed.confirmationMilliseconds === undefined)
        signed.confirmationMilliseconds = Math.round(performance.now() - signed.startedAt);
    } catch {
      // Intentional browser outages can cancel receipt response bodies.
    }
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
  await dialog.waitFor({ state: 'hidden' });
}
async function createMatch({ uncertain = false } = {}) {
  const [host, guest] = players;
  await lobby(host);
  await lobby(guest);
  host.receiptBlocked = uncertain;
  const before = host.writes.length;
  await host.page.getByRole('button', { name: 'Create room', exact: true }).click();
  if (uncertain) {
    const check = await waitForReceiptRecovery(host.page);
    const submitted = (await transactionState(host.page)).hash;
    assert.equal(host.writes.length, before + 1, 'Only one creation may be broadcast.');
    assert.equal(await host.page.locator('.create-panel button').isDisabled(), true);
    await check.click();
    await waitForReceiptRecovery(host.page);
    assert.equal(host.writes.length, before + 1, 'Checking a receipt must never rebroadcast.');
    await host.page.reload();
    await waitForReceiptRecovery(host.page);
    assert.equal(
      (await transactionState(host.page)).hash,
      submitted,
      'Reload must restore the original transaction hash.',
    );
    assert.equal(await host.page.locator('.create-panel button').isDisabled(), true);
    const journal = await host.page.evaluate(() =>
      Object.keys(sessionStorage)
        .filter((key) => key.startsWith('arena-pending:'))
        .map((key) => JSON.parse(sessionStorage.getItem(key))),
    );
    assert.equal(journal.length, 1);
    assert.deepEqual(Object.keys(journal[0]).sort(), ['hash', 'operation']);
    host.receiptBlocked = false;
    await check.click();
    passed(
      'refresh restores an unconfirmed creation by its original hash without storing orders or rebroadcasting',
    );
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
  await host.page.evaluate(() => {
    window.arenaInvitationCopy = undefined;
  });
  await host.page.getByRole('button', { name: 'Copy invitation', exact: true }).click();
  let invitation;
  await waitFor(async () => {
    const copy = await host.page.evaluate(() => window.arenaInvitationCopy);
    if (copy?.status === 'failed')
      throw new Error(`Copy invitation failed (${browserName}): ${copy.error}`);
    if (copy?.status !== 'copied') return false;
    invitation = copy.text;
    return true;
  }, 'The browser did not complete this invitation clipboard write.');
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
  const beforeStart = host.writes.length;
  host.receiptBlocked = uncertain;
  await start.click();
  for (const { page } of players) {
    await page.waitForURL(new RegExp(`/rooms/${id}/battle$`));
    await page.locator('.renderer[data-ready="true"]').waitFor();
  }
  if (uncertain) {
    await waitForReceiptRecovery(host.page);
    assert.equal((await transactionState(host.page)).operation, 'start');
    await host.page.reload();
    const check = await waitForReceiptRecovery(host.page);
    host.receiptBlocked = false;
    await check.click();
    await waitFor(
      async () => (await transactionState(host.page)).status === 'confirmed',
      'The restored host start did not confirm from the battlefield.',
    );
    assert.equal(
      host.writes.length,
      beforeStart + 1,
      'Recovering host start must not send it again.',
    );
    passed(
      'an unconfirmed host start remains recoverable after entering and refreshing the battlefield',
    );
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
  await player.page.getByRole('button', { name: /^(Orders backup|Restore orders)$/ }).click();
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
async function closeUnitDrawer(page, cell, inspection) {
  inspection.stage = 'closing';
  await page.getByRole('button', { name: 'Close unit details', exact: true }).focus();
  await page.evaluate(() => {
    window.arenaUnitDrawerClosed = false;
    document.querySelector('dialog[open]').addEventListener(
      'close',
      () => {
        // Read focus after the close handlers and Vue's next-tick restoration have run.
        requestAnimationFrame(() => {
          window.arenaUnitDrawerClosed = true;
        });
      },
      { once: true },
    );
  });
  await page.keyboard.press('Escape');
  await waitFor(async () => {
    const closed = await page.evaluate(() => ({
      restored: window.arenaUnitDrawerClosed,
      open: !!document.querySelector('dialog[open]'),
      focusedCell: document.activeElement?.getAttribute('data-cell'),
    }));
    inspection.focusedCell = closed.focusedCell;
    inspection.closeEventObserved = closed.restored;
    return closed.restored && !closed.open && closed.focusedCell === String(cell);
  }, `Unit drawer did not close and restore focus to board cell ${cell}.`);
  inspection.stage = 'closed';
}
async function checkViewports() {
  const [host, guest] = players;
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1000, height: 640 },
    { width: 390, height: 844 },
  ]) {
    for (const player of players) {
      await player.page.bringToFront();
      await player.page.setViewportSize(viewport);
      const cell = await player.page
        .locator(
          `.keyboard-grid button[aria-label*="Player ${player.index === 0 ? 'A' : 'B'} Scout,"]`,
        )
        .getAttribute('data-cell');
      assert.notEqual(cell, null, 'The Scout must have an accessible board tile.');
      const focus = {
        viewport,
        player: player.index,
        expectedCell: cell,
        stage: 'opening',
        navigation: [],
      };
      report.drawerFocus = focus;
      const started = performance.now();
      await player.page
        .locator('.squad')
        .getByRole('button', { name: /^Scout,/ })
        .click();
      const drawer = player.page.getByRole('dialog', { name: 'Scout', exact: true });
      await drawer.waitFor();
      report.timings.interactions.push({
        operation: 'open-unit-drawer',
        viewport,
        player: player.index,
        durationMilliseconds: Math.round(performance.now() - started),
      });
      const focusState = () =>
        drawer.evaluate((element) => {
          const active = document.activeElement;
          return {
            open: element.open,
            inside: element.contains(active),
            neutral: active === document.body || active === document.documentElement,
            documentFocused: document.hasFocus(),
            tag: active?.tagName ?? null,
            id: active?.id ?? null,
            label: active?.getAttribute('aria-label') ?? null,
            cell: active?.getAttribute('data-cell') ?? null,
          };
        });
      await waitFor(async () => {
        focus.initial = await focusState();
        return focus.initial.open && focus.initial.inside;
      }, 'Opening the unit drawer did not focus a control inside it.');
      focus.stage = 'navigation';
      for (const key of ['Tab', 'Shift+Tab']) {
        await player.page.keyboard.press(key);
        const actual = await focusState();
        focus.navigation.push({ key, ...actual });
        // Native dialogs may send focus to browser controls, but never to background page controls.
        assert.ok(actual.open && (actual.inside || actual.neutral), JSON.stringify(focus));
      }
      focus.stage = 'background';
      focus.background = await player.page
        .locator('.squad button')
        .first()
        .evaluate((element) => {
          element.focus({ preventScroll: true });
          return { enabled: !element.disabled, blocked: document.activeElement !== element };
        });
      focus.afterBackgroundAttempt = await focusState();
      assert.ok(
        focus.background.enabled &&
          focus.background.blocked &&
          focus.afterBackgroundAttempt.open &&
          (focus.afterBackgroundAttempt.inside || focus.afterBackgroundAttempt.neutral),
        JSON.stringify(focus),
      );
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
      const screenshot = `battle-drawer-${report.engine}-${player.index}-${viewport.width}.png`;
      await player.page.screenshot({ path: resolve(screenshots, screenshot) });
      report.screenshots.push(`${browserName}/${screenshot}`);
      await closeUnitDrawer(player.page, cell, focus);
    }
    report.viewports.push({ ...viewport, browser: report.browser });
  }
  for (const player of [host, guest])
    await player.page.setViewportSize({ width: 1100, height: 760 });
  const tile = host.page.locator('[data-cell="0"]');
  await host.page.bringToFront();
  await tile.focus();
  await tile.press('ArrowRight');
  assert.equal(await host.page.evaluate(() => document.activeElement.dataset.cell), '1');
  await host.page.keyboard.press('Home');
  assert.equal(await host.page.evaluate(() => document.activeElement.dataset.cell), '0');
  passed(
    'desktop, editor-sized and phone-sized viewports preserve board space, birth-side drawers, native modal focus, background isolation and keyboard dismissal',
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
  await host.page.getByRole('button', { name: 'Confirm orders', exact: true }).click();
  await confirmation.waitFor();
  let releaseSnapshot;
  host.snapshotGate = new Promise((done) => {
    releaseSnapshot = done;
  });
  try {
    await waitFor(() => host.snapshotHeld, 'The background snapshot read did not start.');
    const confirmButton = confirmation.getByRole('button', { name: 'Confirm', exact: true });
    assert.equal(
      await confirmButton.isEnabled(),
      true,
      'A background snapshot read must not disable confirmation of valid orders.',
    );
    await confirmButton.click();
    await confirmation.waitFor({ state: 'hidden' });
    assert.equal(
      host.writes.length,
      before,
      'Confirmation must await the pending snapshot before sending a transaction.',
    );
  } finally {
    host.snapshotGate = undefined;
    host.snapshotHeld = false;
    releaseSnapshot();
  }
  await host.page.getByRole('button', { name: 'Retry confirmation', exact: true }).waitFor();
  assert.equal((await read('getRoundStatus', [id])).committed[0], false);
  host.receiptBlocked = true;
  await host.page.getByRole('button', { name: 'Retry confirmation', exact: true }).click();
  await committed(id, 0);
  await waitForReceiptRecovery(host.page);
  assert.equal(host.writes.length, before + 2, 'One failed send and one successful retry only.');
  passed(
    'confirmation during a pending snapshot read closes the dialog, waits for refresh, and commits once after a failed-send retry',
  );
  const writesAfterCommit = host.writes.length;
  const submittedHash = (await transactionState(host.page)).hash;
  const receiptReadsBeforeReload = host.receiptReads.length;
  host.receiptBlocked = false;
  await host.page.reload();
  await host.page.getByText('Orders confirmed', { exact: true }).waitFor();
  await waitFor(
    async () =>
      !['sending', 'pending', 'unconfirmed'].includes((await transactionState(host.page)).status),
    'Reload did not complete its automatic original-receipt check.',
  );
  assert.deepEqual(
    host.receiptReads.slice(receiptReadsBeforeReload),
    [submittedHash],
    'Reload must check the original receipt once without waiting for a manual click.',
  );
  assert.equal(
    host.writes.length,
    writesAfterCommit,
    'Reload must restore orders without broadcasting a new Commit.',
  );
  passed(
    'refresh automatically checks the saved original receipt once and restores confirmed orders without rebroadcasting',
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
  const path = resolve(screenshots, `gameplay-backup-${report.engine}.json`);
  await (await download).saveAs(path);
  const encrypted = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(encrypted.cipher, 'AES-GCM');
  assert.equal(encrypted.actions, undefined, 'Backup must not contain plaintext orders.');
  assert.equal(encrypted.salt.length > 0, true);
  await dialog.getByRole('button', { name: 'Close backup', exact: true }).click();
  await backup(guest, path, password, /do not match/);
  await lobby(host);
  await host.page.getByLabel('Active account', { exact: true }).selectOption(guest.account);
  await host.page.goto(`${base}/rooms/${id}/battle`);
  await waitFor(
    () => host.page.getByRole('button', { name: 'Confirm orders', exact: true }).isEnabled(),
    "Switching accounts must restore the other player's own planning state.",
  );
  assert.equal(
    await host.page.evaluate(
      () =>
        !!document.getElementById('app').__vue_app__.config.globalProperties.$pinia.state.value
          .battle.secret,
    ),
    false,
    'The other account must not inherit saved orders.',
  );
  await lobby(host);
  await host.page.goto(`${base}/rooms/${id}/battle`);
  await host.page.getByText('Orders confirmed', { exact: true }).waitFor();
  assert.equal(
    host.writes.length,
    writesAfterCommit,
    'Switching back must restore the original orders without another Commit.',
  );
  passed(
    "lobby account switching isolates plans and restores the original account's saved commitment",
  );
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
  const missingScreenshot = `missing-orders-${report.engine}.png`;
  await host.page.screenshot({ path: resolve(screenshots, missingScreenshot) });
  report.screenshots.push(`${browserName}/${missingScreenshot}`);
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

async function protection(id) {
  const host = players[0];
  const before = host.writes.length;
  await host.page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    window.restoreOrderStorage = () => {
      IDBDatabase.prototype.transaction = original;
    };
    IDBDatabase.prototype.transaction = function (stores, mode, options) {
      if (mode === 'readwrite' && (stores === 'secrets' || Array.from(stores).includes('secrets')))
        throw new DOMException('Controlled order storage failure', 'QuotaExceededError');
      return original.call(this, stores, mode, options);
    };
  });
  try {
    await confirm(host);
    await host.page
      .getByRole('alert')
      .filter({ hasText: /Orders could not be saved. Nothing was submitted/ })
      .waitFor();
    assert.equal(host.writes.length, before, 'Storage failure must prevent all signed broadcasts.');
    assert.equal((await read('getRoundStatus', [id])).committed[0], false);
    await host.page.screenshot({
      path: resolve(screenshots, `storage-recovery-${report.engine}.png`),
    });
  } finally {
    await host.page.evaluate(() => {
      window.restoreOrderStorage();
      delete window.restoreOrderStorage;
    });
  }
  await host.page.getByRole('button', { name: 'Refresh chain state', exact: true }).click();
  await waitFor(
    () => host.page.getByRole('button', { name: 'Confirm orders', exact: true }).isEnabled(),
    'Restored storage did not unlock valid confirmation.',
  );
  passed('failed IndexedDB saves block broadcast and recover after storage access returns');

  host.wrongChain = true;
  try {
    await host.page.getByRole('button', { name: 'Refresh chain state', exact: true }).click();
    await host.page
      .getByRole('alert')
      .filter({ hasText: /different chain/ })
      .first()
      .waitFor();
    assert.equal(
      await host.page.getByRole('button', { name: 'Confirm orders', exact: true }).isDisabled(),
      true,
    );
    assert.equal(host.writes.length, before, 'Wrong-chain reads must never trigger a broadcast.');
    await host.page.screenshot({ path: resolve(screenshots, `wrong-chain-${report.engine}.png`) });
  } finally {
    host.wrongChain = false;
  }
  await waitFor(
    () => host.page.getByRole('button', { name: 'Confirm orders', exact: true }).isEnabled(),
    'Correct-chain recovery did not retain the room and unlock confirmation.',
  );
  passed('wrong-chain connections disable submission and recover on the original room');
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
  const started = performance.now();
  report.replayChecks.attempted++;
  const replay = await api(`/matches/${id}/replay?limit=100`);
  assert.equal(replay.match.outcome, outcome);
  assert.equal(replay.match.reason, reason);
  assert.equal(
    replay.verification.status,
    'Verified',
    'Actual UI transactions must independently replay to the chain state.',
  );
  report.replayChecks.verified++;
  report.timings.verification.push({
    match: id.toString(),
    durationMilliseconds: Math.round(performance.now() - started),
  });
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
    const player = players.find(
      (entry) => entry.account.toLowerCase() === transaction.from.toLowerCase(),
    );
    assert.ok(player, 'Gameplay must come from the selected browser wallets.');
    const signed = player.writes.findLast((write) => write.hash === hash);
    assert.ok(signed, 'Every gameplay receipt must match a browser-signed raw transaction.');
    assert.equal(signed.from, player.account, 'The signature must belong to the selected wallet.');
    assert.equal(
      signed.chainId,
      deployment.chainId,
      'Signed gameplay must target the local chain.',
    );
    report.receipts.push({
      match: id.toString(),
      hash,
      block: receipt.blockNumber.toString(),
      from: transaction.from,
      broadcastMethod: 'eth_sendRawTransaction',
      operation: Object.keys(selectors).find((name) => selectors[name] === signed.selector),
      gasUsed: Number(receipt.gasUsed),
      confirmationMilliseconds: signed.confirmationMilliseconds ?? null,
      conditions: signed.conditions,
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
async function play(reference) {
  const faulted = reference.name === 'points';
  report.scenario = {
    name: reference.name,
    conditions: faulted ? 'controlled-faults' : 'normal',
    step: 'create-and-start',
  };
  if (!faulted) requireNoGameplayFaults();
  const started = performance.now();
  const id = await createMatch({ uncertain: faulted });
  const playStarted = performance.now();
  let saved;
  if (faulted) {
    report.scenario.step = 'layout-and-order-recovery';
    await checkViewports();
    await protection(id);
    saved = await recovery(id);
  }
  for (const round of reference.rounds) {
    const roundStarted = round.round === 1 ? playStarted : performance.now();
    report.scenario.step = 'round';
    report.scenario.round = round.round;
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
        const check = await waitForReceiptRecovery(players[0].page);
        const originalHash = (await transactionState(players[0].page)).hash;
        await players[0].page.reload();
        await waitForReceiptRecovery(players[0].page);
        assert.equal((await transactionState(players[0].page)).hash, originalHash);
        assert.notEqual(
          (await transactionState(players[1].page)).hash,
          originalHash,
          "Other accounts must not restore this tab's transaction.",
        );
        players[0].receiptBlocked = false;
        await check.click();
        await players[0].page.getByText('Orders confirmed', { exact: true }).waitFor();
        assert.equal(
          players[0].writes.length,
          before + 1,
          'Receipt recovery must keep the original single Commit.',
        );
        passed(
          'battle receipt recovery survives refresh, keeps account isolation and never resubmits the locked squad',
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
    report.timings.rounds.push({
      scenario: reference.name,
      round: round.round,
      conditions: report.scenario.conditions,
      durationMilliseconds: Math.round(performance.now() - roundStarted),
    });
  }
  const playFinished = performance.now();
  apiOffline = false;
  requireNoGameplayFaults();
  report.scenario.step = 'history-recovery';
  const replay = await verifyMatch(id, reference.state.outcome, reference.state.reason);
  for (const player of players) {
    await player.page.getByRole('link', { name: 'View replay', exact: true }).click();
    report.replayRecovery = { player: player.index, match: id.toString() };
    await waitForVerifiedReplay(
      player.page,
      {
        frame: 0,
        hash: replay.items[0].computedHash,
        last: replay.items.length - 1,
      },
      report.replayRecovery,
    );
  }
  report.scenario.step = 'replay-controls';
  await checkReplay(players[0].page, replay);
  passed(
    `two independent local accounts complete ${reference.name} through real UI controls, receipts, round states and verified history`,
  );
  report.timings.matches.push({
    scenario: reference.name,
    match: id.toString(),
    rounds: reference.rounds.length,
    durationMilliseconds: Math.round(playFinished - started),
    playMilliseconds: Math.round(playFinished - playStarted),
    inspectionMilliseconds: Math.round(performance.now() - playFinished),
    conditions: report.scenario.conditions,
  });
  return saved;
}
async function checkReplay(page, replay) {
  requireNoGameplayFaults();
  report.replayEntry = {};
  await waitForVerifiedReplay(
    page,
    {
      frame: 0,
      hash: replay.items[0].computedHash,
      last: replay.items.length - 1,
    },
    report.replayEntry,
  );
  const jump = page.getByRole('combobox', { name: 'Jump to round', exact: true });
  await page.locator('.renderer[data-ready="true"]').waitFor();
  for (const viewport of [
    { width: 1100, height: 760 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await jump.selectOption('0');
    for (const unitId of [0, 3]) {
      const cell = replay.items[0].state.units[unitId].cell;
      const coordinate = `${String.fromCharCode(65 + (cell % 8))}${Math.floor(cell / 8) + 1}`;
      const inspection = {
        viewport,
        unitId,
        cell,
        expectedOwner: `Player ${unitId < 3 ? 'A' : 'B'} · ${coordinate}`,
        expectedSide: unitId < 3 ? 'left' : 'right',
        stage: 'opening',
      };
      report.replayInspection = inspection;
      await page.locator(`[data-cell="${cell}"]`).focus();
      await page.keyboard.press('Enter');
      await waitFor(async () => {
        inspection.actual = await page.evaluate(() => {
          const element = document.querySelector('dialog[open] .unit-panel');
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          const close = element.querySelector('.dismiss').getBoundingClientRect();
          return {
            owner: element.querySelector('.owner').textContent.replace(/\s+/g, ' ').trim(),
            left: rect.left,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            scroll: element.scrollWidth,
            client: element.clientWidth,
            closeLeft: close.left,
            closeRight: close.right,
            closeHeight: close.height,
          };
        });
        return inspection.actual?.owner === inspection.expectedOwner;
      }, `Replay drawer did not show ${inspection.expectedOwner}.`);
      inspection.stage = 'layout';
      const bounds = inspection.actual;
      const diagnostic = JSON.stringify(inspection);
      assert.ok(unitId < 3 ? bounds.left < 16 : bounds.right > viewport.width - 16, diagnostic);
      assert.ok(bounds.width < viewport.width / 4, diagnostic);
      assert.ok(bounds.right <= viewport.width && bounds.bottom <= viewport.height, diagnostic);
      assert.ok(bounds.scroll <= bounds.client + 1, diagnostic);
      assert.ok(bounds.closeLeft >= bounds.left && bounds.closeRight <= bounds.right, diagnostic);
      assert.ok(bounds.closeHeight >= 44, diagnostic);
      await closeUnitDrawer(page, cell, inspection);
    }
  }
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.getByRole('combobox', { name: 'Playback speed', exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await waitFor(
    async () => Number(await page.locator('.replay-screen').getAttribute('data-frame-index')) > 0,
    'Replay playback did not advance.',
  );
  await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
  const terminal = {
    phase: 'seek',
  };
  report.replayTerminal = terminal;
  const end = {
    frame: replay.items.length - 1,
    last: replay.items.length - 1,
    hash: replay.match.stateHash,
  };
  await jump.selectOption(String(end.frame));
  await waitForVerifiedReplay(page, end, terminal);
  terminal.phase = 'refresh';
  await page.getByRole('button', { name: 'Refresh replay', exact: true }).click();
  await waitForVerifiedReplay(page, end, terminal);
  passed(
    'replay keyboard inspection, narrow drawer, playback, speed, terminal timeline and refresh',
  );
}
async function timeout(phase, bothMissing = false, saved) {
  report.scenario = {
    name: `${phase === 2 ? 'Commit' : 'Reveal'} timeout ${bothMissing ? 'draw' : 'win'}`,
    conditions: 'controlled-faults',
    step: 'create-and-start',
  };
  const id = await createMatch();
  if (saved) await backup(players[0], saved.path, saved.password, /do not match/);
  report.scenario.step = 'withholding-and-expiry';
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
  const host = players[0];
  assert.equal(
    await host.page.getByRole('button', { name: 'Finalize timeout', exact: true }).count(),
    0,
    'An unexpired phase must not offer timeout finalization.',
  );
  let expiredReminder;
  const writesBeforeExpiry = host.writes.length;
  if (phase === 2 && bothMissing) {
    await host.page.getByRole('button', { name: 'Confirm orders', exact: true }).click();
    expiredReminder = host.page.getByRole('dialog', { name: 'Confirm orders?', exact: true });
    await expiredReminder.waitFor();
  }
  if (deployment.engine === 'geth') {
    await chain.request({
      method: 'arena_advanceClock',
      params: [`0x${(room.phaseDeadline + 1n).toString(16)}`],
    });
  } else {
    await chain.request({
      method: 'evm_setNextBlockTimestamp',
      params: [Number(room.phaseDeadline) + 1],
    });
    await chain.request({ method: 'evm_mine', params: [] });
  }
  const refresh = host.page.getByRole('button', { name: 'Refresh chain state', exact: true });
  if (expiredReminder) {
    await waitFor(() => refresh.isEnabled(), 'The expiry observation did not become available.');
    await refresh.evaluate((button) => button.click());
  } else await refresh.click();
  const finalize = players[0].page.getByRole('button', { name: 'Finalize timeout', exact: true });
  await waitFor(
    () => finalize.isEnabled(),
    'Expired phases must expose a usable manual timeout control.',
  );
  if (expiredReminder) {
    assert.equal(
      await expiredReminder.getByRole('button', { name: 'Confirm', exact: true }).isDisabled(),
      true,
      'A reminder opened before expiry must not authorize an expired Commit.',
    );
    assert.equal(host.writes.length, writesBeforeExpiry);
    await host.page.screenshot({
      path: resolve(screenshots, `expired-confirmation-${report.engine}.png`),
    });
    await expiredReminder
      .locator('.confirmation-actions')
      .getByRole('button', { name: 'Keep editing', exact: true })
      .click();
    passed(
      'early timeout controls stay hidden and an expired confirmation reminder cannot broadcast',
    );
  }
  const writesBeforeTimeout = host.writes.length;
  if (phase === 2 && bothMissing) {
    let releaseSnapshot;
    host.snapshotGate = new Promise((done) => {
      releaseSnapshot = done;
    });
    try {
      const refresh = host.page.getByRole('button', { name: 'Refresh chain state', exact: true });
      await waitFor(async () => {
        if (!host.snapshotHeld) await refresh.evaluate((button) => button.click());
        return host.snapshotHeld;
      }, 'The timeout snapshot read did not start.');
      await finalize.click();
      await waitFor(() => finalize.isDisabled(), 'Timeout submission did not lock the action.');
      assert.equal(
        host.writes.length,
        writesBeforeTimeout,
        'Timeout must wait for the pending snapshot.',
      );
    } finally {
      host.snapshotGate = undefined;
      host.snapshotHeld = false;
      releaseSnapshot();
    }
  } else await finalize.click();
  await waitFor(async () => {
    const state = await transactionState(host.page);
    if (state.operation !== 'timeout' || state.roomId !== id.toString()) return false;
    if (state.status === 'failed' || state.status === 'unconfirmed')
      throw new Error(`Timeout submission failed: ${state.diagnostic || state.message}`);
    return !!state.hash;
  }, 'The timeout click did not submit a transaction for this room.');
  await roundDone(id, 1);
  assert.equal(
    host.writes.length,
    writesBeforeTimeout + 1,
    'One timeout click must broadcast once.',
  );
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

async function battleReorganization() {
  if (deployment.engine === 'geth') return;
  report.scenario = {
    name: 'battle reorganization',
    conditions: 'controlled-faults',
    step: 'branch replacement',
  };
  apiOffline = true;
  for (const response of streams) response.destroy();
  try {
    const id = await createMatch();
    const host = players[0];
    const branch = await chain.request({ method: 'evm_snapshot' });
    await confirm(host);
    await committed(id, 0);
    await host.page.getByText('Orders confirmed', { exact: true }).waitFor();
    const before = host.writes.length;
    const originalSecret = await host.page.evaluate(() => {
      const secret =
        document.getElementById('app').__vue_app__.config.globalProperties.$pinia.state.value.battle
          .secret;
      return { commitment: secret.commitment, salt: secret.salt };
    });
    assert.equal(await chain.request({ method: 'evm_revert', params: [branch] }), true);
    await host.page.getByRole('button', { name: 'Refresh chain state', exact: true }).click();
    await host.page.getByText(/The chain reorganized. Previous results were withdrawn/).waitFor();
    await host.page.getByRole('button', { name: 'Check confirmation', exact: true }).click();
    await host.page
      .getByRole('alert')
      .filter({ hasText: /removed by the reorganization/ })
      .waitFor();
    assert.equal(host.writes.length, before, 'A reorganization must never automatically recommit.');
    const retained = await host.page.evaluate(() => {
      const secret =
        document.getElementById('app').__vue_app__.config.globalProperties.$pinia.state.value.battle
          .secret;
      return { commitment: secret.commitment, salt: secret.salt };
    });
    assert.equal(
      retained.commitment === originalSecret.commitment && retained.salt === originalSecret.salt,
      true,
      'A displaced Commit must keep the original orders and Salt.',
    );
    assert.equal((await read('getRoundStatus', [id])).committed[0], false);
    await host.page.screenshot({ path: resolve(screenshots, 'battle-reorganization.png') });
    await host.page.getByRole('button', { name: 'Retry confirmation', exact: true }).click();
    await committed(id, 0);
    await confirm(players[1]);
    await roundDone(id, 1);
    passed(
      'battle reorganization withdraws confirmation, preserves the original secret and requires a manual retry',
    );
  } finally {
    apiOffline = false;
  }
}

await mkdir(output, { recursive: true });
await mkdir(screenshots, { recursive: true });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = true;
    void browser?.close();
  });
try {
  await requirePreviewDeployment(root, deployment);
  const executablePath = await installedBrowser(browserName);
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
  if (deployment.engine !== 'geth') original = await chain.request({ method: 'evm_snapshot' });
  server = await preview({
    root: resolve(root, 'client'),
    configFile: resolve(root, 'client/vite.config.js'),
    preview: { host: '127.0.0.1', port: browserPort, strictPort: true },
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
  browser = await browserType.launch({ headless: true, executablePath });
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
  await play(elimination);
  await timeout(2, false, saved);
  await timeout(3);
  await timeout(2, true);
  await timeout(3, true);
  await battleReorganization();
  passed(
    'all gameplay receipts match locally signed raw transactions from the selected wallets on chain 31337; node-managed browser signing is rejected',
  );
  assert.deepEqual(report.errors, [], 'Uncaught browser errors');
  report.scenario.step = 'completed';
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack || String(error);
  report.transactions = await Promise.all(
    players.map((player) => transactionState(player.page).catch(() => undefined)),
  );
  report.pages = await Promise.all(
    players.map((player) => replayState(player.page).catch(() => undefined)),
  );
  process.exitCode = 1;
  console.error(
    `${browserName} gameplay failed in ${report.scenario?.name} at ${report.scenario?.step}: ${error.message}`,
  );
  for (const player of players)
    if (!player.page.isClosed())
      await player.page
        .screenshot({
          path: resolve(screenshots, `gameplay-failure-${report.engine}-${player.index}.png`),
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
  if (browserName === 'chromium')
    await writeFile(resolve(output, 'gameplay.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    resolve(
      output,
      browserName === 'chromium'
        ? `gameplay-${report.engine}.json`
        : `gameplay-${report.engine}-${browserName}.json`,
    ),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (report.status === 'passed')
    console.log(
      'PASS: real browser gameplay and recovery acceptance completed. Local gameplay report saved.',
    );
}
