import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { installedBrowser } from './browser.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const clientRoot = resolve(root, 'client');
const output = resolve(root, '.local/browser');
const run = promisify(execFile);
const backend = `http://${process.env.HTTP_ADDRESS || '127.0.0.1:18081'}`;
const acceptance = JSON.parse(
  await readFile(resolve(root, '.local/indexer/acceptance.json'), 'utf8'),
);
assert.equal(acceptance.status, 'passed', 'Backend acceptance must pass before browser checks.');
const report = { status: 'running', checks: [], errors: [], startedAt: new Date().toISOString() };
await mkdir(output, { recursive: true });
let server,
  browser,
  page,
  faultActive = false,
  chainSnapshot;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = true;
    void browser?.close();
  });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function passed(name) {
  report.checks.push(name);
  console.log(`PASS: browser ${name}.`);
}
async function api(path) {
  const response = await fetch(`${backend}${path}`, { signal: AbortSignal.timeout(35_000) });
  assert.equal(response.status, 200, `API ${path}`);
  return response.json();
}
async function rpc(method, params = []) {
  const response = await fetch('http://127.0.0.1:18545', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const value = await response.json();
  if (value.error) throw new Error(`${method}: ${value.error.message}`);
  return value.result;
}
async function fault(operation) {
  const result = await run(resolve(root, '.local/bin/arena-server'), ['browser-fault', operation], {
    cwd: resolve(root, 'server'),
    timeout: 15_000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
}
async function waitFor(check, message) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('Browser acceptance interrupted.');
    if (await check()) return;
    await pause(100);
  }
  throw new Error(message);
}
async function badge(value) {
  await page.locator(`[data-verification="${value}"]`).waitFor({ state: 'visible' });
}
async function frame(index, hash) {
  await page.waitForFunction(
    ({ index, hash }) => {
      const main = document.querySelector('.replay-screen');
      return (
        main?.getAttribute('data-frame-index') === String(index) &&
        (!hash || main.getAttribute('data-state-hash') === hash)
      );
    },
    { index, hash },
  );
}
async function screenshot(name) {
  await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
}
async function restoreChain() {
  if (!chainSnapshot) return;
  assert.equal(
    await rpc('evm_revert', [chainSnapshot.id]),
    true,
    'Restore browser acceptance chain snapshot.',
  );
  await waitFor(async () => {
    try {
      const meta = await api('/ready');
      return meta.indexedBlock === chainSnapshot.block && meta.indexedHash === chainSnapshot.hash;
    } catch {
      return false;
    }
  }, 'Indexer did not recover after browser acceptance rollback.');
  chainSnapshot = undefined;
}

try {
  const executablePath = await installedBrowser();
  server = await createServer({
    root: clientRoot,
    configFile: resolve(clientRoot, 'vite.config.js'),
    server: { host: '127.0.0.1', port: 5174, strictPort: true, ws: { port: 5174 } },
  });
  const headers = server.config.server.headers;
  if (headers?.['Content-Security-Policy'])
    headers['Content-Security-Policy'] = String(headers['Content-Security-Policy']).replace(
      'ws://127.0.0.1:5173',
      'ws://127.0.0.1:5174',
    );
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({
    viewport: { width: 1100, height: 760 },
    reducedMotion: 'no-preference',
  });
  page = await context.newPage();
  page.on('pageerror', (error) => report.errors.push(error.message));
  const base = 'http://127.0.0.1:5174';
  const first = acceptance.matches[0];
  const pageNumber = Number((BigInt(first.id) - 1n) / 10n) + 1;
  await page.goto(`${base}/history?page=${pageNumber}`);
  await page.getByRole('link', { name: `View match ${first.id}`, exact: true }).waitFor();
  const list = await api(`/matches?limit=10&offset=${(pageNumber - 1) * 10}`);
  assert.equal(await page.locator('tbody tr').count(), list.items.length);
  assert.equal(
    await page.getByRole('button', { name: 'Next page', exact: true }).isDisabled(),
    !list.hasMore,
  );
  passed('history list and API pagination agree');

  for (const entry of acceptance.matches) {
    await page.goto(`${base}/history/${entry.id}`);
    await badge('Verified');
    await page.locator('.renderer[data-ready="true"]').waitFor();
    await frame(0, entry.snapshots[0].stateHash);
    const select = page.getByRole('combobox', { name: 'Jump to round', exact: true });
    await select.selectOption('3');
    await frame(3, entry.snapshots[3].stateHash);
    await page.getByRole('button', { name: 'Previous round', exact: true }).click();
    await frame(2, entry.snapshots[2].stateHash);
    await page.getByRole('button', { name: 'Next round', exact: true }).click();
    await frame(3, entry.snapshots[3].stateHash);
    await page.waitForFunction(
      () => document.querySelector('.replay-screen')?.getAttribute('data-animating') === 'false',
    );
    assert.equal(await page.locator('.replay-screen').getAttribute('data-playing'), 'false');
    await page.reload();
    await badge('Verified');
    await frame(3, entry.snapshots[3].stateHash);
    const finalIndex = entry.snapshots.length - 1;
    await select.selectOption(String(finalIndex));
    await frame(finalIndex, entry.stateHash);
    const range = page.getByRole('slider', { name: 'Replay timeline' });
    assert.equal(await range.inputValue(), await range.getAttribute('max'));
    assert.equal(
      await page
        .locator('.timeline')
        .evaluate((element) => element.style.getPropertyValue('--timeline-progress')),
      '100%',
    );
    assert.equal(await range.evaluate((element) => getComputedStyle(element).paddingRight), '0px');
    assert.match(await page.locator('.timeline-heading').innerText(), /Player A wins/);
    passed(
      `match ${entry.id} initial state, backward/forward jumps, refresh, and chain terminal hash`,
    );
  }

  await page.goto(`${base}/history/${first.id}`);
  await badge('Verified');
  await page.locator('.renderer[data-ready="true"]').waitFor();
  const refreshBox = await page.getByRole('button', { name: 'Refresh replay' }).boundingBox();
  const badgeBox = await page.locator('.verification-badge').boundingBox();
  const iconBox = await page
    .getByRole('button', { name: 'Refresh replay' })
    .locator('svg')
    .boundingBox();
  assert.ok(refreshBox && badgeBox && iconBox);
  assert.ok(Math.abs(refreshBox.y + refreshBox.height / 2 - badgeBox.y - badgeBox.height / 2) <= 1);
  assert.ok(Math.abs(refreshBox.y + refreshBox.height / 2 - iconBox.y - iconBox.height / 2) <= 1);
  assert.ok(Math.abs(refreshBox.x + refreshBox.width / 2 - iconBox.x - iconBox.width / 2) <= 1);
  const moveIndex = first.snapshots.findIndex(
    (snapshot, index) =>
      index > 0 &&
      snapshot.state.units.some(
        (unit, slot) =>
          unit.hp > 0 && unit.cell !== first.snapshots[index - 1].state.units[slot].cell,
      ),
  );
  assert.ok(moveIndex > 0, 'The acceptance match must contain a successful movement.');
  async function playSingleRound(speed) {
    await page.getByRole('combobox', { name: 'Jump to round' }).selectOption(String(moveIndex - 1));
    await page.getByRole('combobox', { name: 'Playback speed' }).selectOption(String(speed));
    const started = Date.now();
    await page.getByRole('button', { name: 'Next round', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('.replay-screen')?.getAttribute('data-animating') === 'true',
    );
    await page.waitForFunction(
      () => document.querySelector('.replay-screen')?.getAttribute('data-animating') === 'false',
    );
    await frame(moveIndex, first.snapshots[moveIndex].stateHash);
    assert.equal(await page.locator('.replay-screen').getAttribute('data-playing'), 'false');
    return Date.now() - started;
  }
  const slow = await playSingleRound(0.5);
  const fast = await playSingleRound(2);
  assert.ok(
    slow > fast * 1.6,
    `Playback speed did not scale the round: 0.5x=${slow}ms, 2x=${fast}ms`,
  );
  await page.getByRole('combobox', { name: 'Playback speed' }).selectOption('1');
  await page.getByRole('button', { name: 'Return to initial state' }).click();
  passed(
    'timeline reaches its end, refresh icon aligns, and Next animates once at the selected speed',
  );
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.replay-screen')?.getAttribute('data-animating') === 'true',
  );
  await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
  const frozenFrame = await page.locator('.replay-screen').getAttribute('data-frame-index');
  await pause(800);
  assert.equal(await page.locator('.replay-screen').getAttribute('data-frame-index'), frozenFrame);
  assert.equal(await page.locator('.replay-screen').getAttribute('data-animating'), 'true');
  await page.getByRole('combobox', { name: 'Playback speed' }).selectOption('4');
  assert.equal(await page.locator('.replay-screen').getAttribute('data-playing'), 'false');
  assert.equal(await page.locator('.replay-screen').getAttribute('data-animating'), 'true');
  await page.getByRole('combobox', { name: 'Playback speed' }).selectOption('1');
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await page.waitForFunction(
    () => Number(document.querySelector('.replay-screen')?.getAttribute('data-frame-index')) > 1,
  );
  await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
  await page.getByRole('button', { name: 'Return to initial state', exact: true }).click();
  await frame(0, first.snapshots[0].stateHash);
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.replay-screen')?.getAttribute('data-animating') === 'true',
  );
  await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
  await page.getByRole('combobox', { name: 'Jump to round' }).selectOption('3');
  await frame(3, first.snapshots[3].stateHash);
  passed('pause freezes animation, resume advances, and earlier rounds can play again');

  await page.getByText('Round details', { exact: true }).click();
  for (const side of ['A', 'B']) {
    await page.getByRole('button', { name: new RegExp(`Inspect ${side} Guardian`) }).click();
    await page.getByRole('dialog').waitFor({ state: 'visible' });
    const box = await page.locator('.unit-panel').boundingBox();
    assert.ok(box && box.width < 1100 / 4 && box.height <= 760);
    assert.ok(side === 'A' ? box.x < 550 : box.x > 550, 'Drawer must use the unit birth side.');
    await page.getByRole('button', { name: 'Close unit details' }).click();
  }
  await page.getByText('Round details', { exact: true }).click();
  for (const viewport of [
    { width: 720, height: 480 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(() => {
      const canvas = document.querySelector('canvas')?.getBoundingClientRect();
      const controls = document.querySelector('.playback-buttons')?.getBoundingClientRect();
      return (
        canvas &&
        controls &&
        canvas.width > 0 &&
        canvas.left >= 0 &&
        canvas.right <= innerWidth + 1 &&
        canvas.bottom <= controls.top + 1 &&
        controls.bottom <= innerHeight + 1
      );
    });
  }
  await page.setViewportSize({ width: 1100, height: 760 });
  await screenshot('replay');
  passed('birth-side drawers and compact viewport layout');

  faultActive = true;
  await fault('corrupt');
  await page.getByRole('button', { name: 'Refresh replay' }).click();
  await badge('Mismatch');
  await page.getByText('Verification details', { exact: true }).click();
  await page.getByText(/snapshots\[1\]\.state\.units\[0\]\.hp/).waitFor();
  await page.getByRole('button', { name: 'Go to difference' }).click();
  await frame(1);
  await screenshot('mismatch');
  await fault('restore');
  faultActive = false;
  await page.getByRole('button', { name: 'Refresh replay' }).click();
  await badge('Verified');
  passed('real database snapshot tampering shows the affected field and restores Verified');

  const meta = await api('/ready');
  chainSnapshot = {
    id: await rpc('evm_snapshot'),
    block: meta.indexedBlock,
    hash: meta.indexedHash,
  };
  await context.route('**/api/**', (route) => route.abort('connectionrefused'));
  await page.getByRole('button', { name: 'Refresh replay' }).click();
  await badge('Unavailable');
  await page.goto(`${base}/`);
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await page.waitForURL(/\/rooms\/\d+$/);
  const liveId = /\/rooms\/(\d+)$/.exec(page.url())[1];
  const guest = await context.newPage();
  guest.on('pageerror', (error) => report.errors.push(error.message));
  await guest.goto(`${base}/`);
  await guest
    .getByRole('combobox', { name: 'Active account', exact: true })
    .selectOption({ index: 1 });
  await guest.goto(`${base}/rooms/${liveId}`);
  await guest.getByRole('button', { name: 'Join room', exact: true }).click();
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await Promise.all([page.waitForURL(/\/battle$/), guest.waitForURL(/\/battle$/)]);
  for (const player of [page, guest]) {
    await player.getByRole('button', { name: 'Confirm orders', exact: true }).click();
    await player
      .getByRole('dialog', { name: 'Confirm orders?' })
      .getByRole('button', { name: 'Confirm', exact: true })
      .click();
  }
  await page.getByText('Round 2 · Planning', { exact: true }).waitFor();
  await guest.close();
  await page.goto(`${base}/history/${liveId}`);
  await badge('Unavailable');
  await context.unroute('**/api/**');
  await page.getByRole('button', { name: 'Refresh replay' }).click();
  await badge('Incomplete');
  await page.locator('.renderer[data-ready="true"]').waitFor();
  passed(
    'API network failure clears Verified while RPC room creation, host start, and a full round still work',
  );

  await restoreChain();
  await page.getByRole('button', { name: 'Refresh replay' }).click();
  await page.getByRole('heading', { name: 'Replay unavailable', exact: true }).waitFor();
  assert.equal(await page.locator('[data-verification="Verified"]').count(), 0);
  assert.equal(await page.locator('canvas').count(), 0);
  passed('actual chain rollback removes the displaced match and its old replay');
  await page.goto(`${base}/history/${first.id}?frame=3`);
  await badge('Verified');
  await frame(3, first.snapshots[3].stateHash);
  assert.deepEqual(report.errors, [], 'Uncaught browser errors');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack || String(error);
  process.exitCode = 1;
  console.error(`Browser acceptance failed: ${error.message}`);
  if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
} finally {
  try {
    if (faultActive) await fault('restore');
    await restoreChain();
  } catch (error) {
    report.status = 'failed';
    report.cleanupError = error.message;
    process.exitCode = 1;
    console.error(`Browser cleanup failed: ${error.message}`);
  }
  await browser?.close();
  await server?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'passed')
    console.log(
      'PASS: browser history and replay acceptance completed. Local screenshots and report saved.',
    );
}
